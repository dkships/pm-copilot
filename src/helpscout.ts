import { URL, URLSearchParams } from "node:url";

const BASE_URL = "https://api.helpscout.net/v2";
const TOKEN_URL = `${BASE_URL}/oauth2/token`;

// Rate limit: 200 req/min. We stay under 170 to be safe.
const RATE_LIMIT_WINDOW_MS = 60_000;
const MAX_REQUESTS_PER_WINDOW = 170;
const PAGE_DELAY_MS = 250;
const REQUEST_TIMEOUT_MS = 45_000;
const MAX_429_RETRIES = 3;
const RETRY_BACKOFF_MS = 15_000;

interface TokenState {
  accessToken: string;
  expiresAt: number;
}

interface PageInfo {
  totalElements: number;
  totalPages: number;
  number: number;
  size: number;
}

interface ConversationSummary {
  id: number;
  number: number;
  subject: string;
  status: string;
  state: string;
  mailboxId: number;
  createdAt: string;
  closedAt: string | null;
  tags: Array<{ id: number; tag: string }>;
  primaryCustomer: { email: string };
  preview: string;
  // Total thread count from the list API — all thread types (customer
  // messages, agent replies, notes), not just customer back-and-forth.
  threads?: number;
}

export type Conversation = ConversationSummary;

export interface Mailbox {
  id: number;
  name: string;
}

export interface FetchOptions {
  timeframeDays: number;
  mailboxId?: string;
}

export class HelpScoutClient {
  private appId: string;
  private appSecret: string;
  private token: TokenState | null = null;
  private requestTimestamps: number[] = [];
  private mailboxesCache: Mailbox[] | null = null;

  constructor(appId: string, appSecret: string) {
    this.appId = appId;
    this.appSecret = appSecret;
  }

  private async authenticate(): Promise<string> {
    // Return cached token if still valid (with 60s buffer)
    if (this.token && Date.now() < this.token.expiresAt - 60_000) {
      return this.token.accessToken;
    }

    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "client_credentials",
        client_id: this.appId,
        client_secret: this.appSecret,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!res.ok) {
      const text = await res.text();
      if (res.status === 401 || res.status === 403) {
        throw new Error(
          `HelpScout auth failed (${res.status}): Check HELPSCOUT_APP_ID and HELPSCOUT_APP_SECRET in .env. ${text}`
        );
      }
      throw new Error(`HelpScout auth failed (${res.status}): ${text}`);
    }

    const data = (await res.json()) as {
      access_token: string;
      expires_in: number;
    };

    this.token = {
      accessToken: data.access_token,
      expiresAt: Date.now() + data.expires_in * 1000,
    };

    return this.token.accessToken;
  }

  private async rateLimit(): Promise<void> {
    const now = Date.now();
    // Prune timestamps outside the current window
    this.requestTimestamps = this.requestTimestamps.filter(
      (t) => now - t < RATE_LIMIT_WINDOW_MS
    );

    if (this.requestTimestamps.length >= MAX_REQUESTS_PER_WINDOW) {
      const oldestInWindow = this.requestTimestamps[0] ?? now;
      const waitMs = RATE_LIMIT_WINDOW_MS - (now - oldestInWindow) + 100;
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }

    this.requestTimestamps.push(Date.now());
  }

  private async apiGet<T>(
    path: string,
    params?: Record<string, string>,
    retryCount = 0
  ): Promise<T> {
    await this.rateLimit();
    const token = await this.authenticate();

    const url = new URL(`${BASE_URL}${path}`);
    if (params) {
      url.search = new URLSearchParams(params).toString();
    }

    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (res.status === 429) {
      if (retryCount >= MAX_429_RETRIES) {
        throw new Error(
          `HelpScout rate limit exceeded on ${path} after ${MAX_429_RETRIES} retries`
        );
      }
      // Honour Retry-After if present, else exponential backoff.
      const retryAfterHeader = res.headers.get("retry-after");
      const retryAfterMs = retryAfterHeader
        ? Number(retryAfterHeader) * 1000
        : RETRY_BACKOFF_MS * Math.pow(2, retryCount);
      await new Promise((resolve) => setTimeout(resolve, retryAfterMs));
      return this.apiGet(path, params, retryCount + 1);
    }

    if (res.status === 401 || res.status === 403) {
      // Token may have expired — clear cache and throw
      this.token = null;
      const text = await res.text();
      throw new Error(
        `HelpScout auth expired or invalid (${res.status}): ${text}`
      );
    }

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`HelpScout API error (${res.status}) on ${path}: ${text}`);
    }

    return (await res.json()) as T;
  }

  private async fetchConversationsPage(
    query: string,
    mailboxId: string | undefined,
    page: number
  ): Promise<{
    conversations: ConversationSummary[];
    page: PageInfo;
  }> {
    const params: Record<string, string> = {
      query: `(${query})`,
      status: "all",
      sortField: "createdAt",
      sortOrder: "desc",
      page: String(page),
    };

    if (mailboxId) {
      params.mailbox = mailboxId;
    }

    const data = await this.apiGet<{
      _embedded?: { conversations: ConversationSummary[] };
      page: PageInfo;
    }>("/conversations", params);

    return {
      conversations: data._embedded?.conversations ?? [],
      page: data.page,
    };
  }

  /**
   * List all mailboxes (id + name) so callers can resolve a human-readable
   * mailbox name to its numeric ID. Cached for the process lifetime —
   * mailboxes rarely change. Paginated (HelpScout returns 50 per page).
   */
  async fetchMailboxes(): Promise<Mailbox[]> {
    if (this.mailboxesCache) return this.mailboxesCache;

    const fetchPage = (page: number) =>
      this.apiGet<{
        _embedded?: { mailboxes: Array<{ id: number; name: string }> };
        page: PageInfo;
      }>("/mailboxes", { page: String(page) });

    const mailboxes: Mailbox[] = [];
    const first = await fetchPage(1);
    for (const m of first._embedded?.mailboxes ?? []) {
      mailboxes.push({ id: m.id, name: m.name });
    }

    const totalPages = first.page?.totalPages ?? 1;
    for (let page = 2; page <= totalPages; page++) {
      await new Promise((resolve) => setTimeout(resolve, PAGE_DELAY_MS));
      const next = await fetchPage(page);
      for (const m of next._embedded?.mailboxes ?? []) {
        mailboxes.push({ id: m.id, name: m.name });
      }
    }

    this.mailboxesCache = mailboxes;
    return mailboxes;
  }

  async fetchConversations(options: FetchOptions): Promise<Conversation[]> {
    const since = new Date();
    since.setDate(since.getDate() - options.timeframeDays);
    const sinceISO = since.toISOString();
    const nowISO = new Date().toISOString();
    const query = `createdAt:[${sinceISO} TO ${nowISO}]`;

    // Fetch first page to get total count
    const firstPage = await this.fetchConversationsPage(
      query,
      options.mailboxId,
      1
    );
    const allConversations: ConversationSummary[] = [
      ...firstPage.conversations,
    ];
    const totalPages = firstPage.page.totalPages;

    // Fetch remaining pages
    for (let page = 2; page <= totalPages; page++) {
      const result = await this.fetchConversationsPage(
        query,
        options.mailboxId,
        page
      );
      allConversations.push(...result.conversations);
    }

    // Thread bodies are never fetched — excluded by design (avoids N+1 API
    // calls and keeps raw message content out of the pipeline). The list
    // API's `threads` count field is all downstream scoring needs.
    return allConversations;
  }
}
