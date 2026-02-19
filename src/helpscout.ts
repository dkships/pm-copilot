import { URL, URLSearchParams } from "node:url";

const BASE_URL = "https://api.helpscout.net/v2";
const TOKEN_URL = `${BASE_URL}/oauth2/token`;

// Rate limit: 200 req/min. We stay under 170 to be safe.
const RATE_LIMIT_WINDOW_MS = 60_000;
const MAX_REQUESTS_PER_WINDOW = 170;
const PAGE_DELAY_MS = 250;
const REQUEST_TIMEOUT_MS = 30_000;

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
}

interface Thread {
  id: number;
  type: string;
  body: string;
  createdAt: string;
  createdBy: {
    type: "customer" | "user";
    email?: string;
  };
}

export interface Conversation extends ConversationSummary {
  threads: Thread[];
}

export interface FetchOptions {
  timeframeDays: number;
  mailboxId?: string;
  includeThreads?: boolean; // default false — set true for full thread content
}

export class HelpScoutClient {
  private appId: string;
  private appSecret: string;
  private token: TokenState | null = null;
  private requestTimestamps: number[] = [];

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
    params?: Record<string, string>
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
      // Rate limited — back off and retry once
      await new Promise((resolve) => setTimeout(resolve, 15_000));
      return this.apiGet(path, params);
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

  private async fetchThreads(conversationId: number): Promise<Thread[]> {
    const data = await this.apiGet<{
      _embedded?: { threads: Thread[] };
    }>(`/conversations/${conversationId}/threads`);

    return data._embedded?.threads ?? [];
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
      await new Promise((resolve) => setTimeout(resolve, PAGE_DELAY_MS));
      const result = await this.fetchConversationsPage(
        query,
        options.mailboxId,
        page
      );
      allConversations.push(...result.conversations);
    }

    // Skip thread fetching unless explicitly requested — subject + preview
    // is sufficient for theme analysis and avoids N+1 API calls
    if (!options.includeThreads) {
      return allConversations.map((conv) => ({ ...conv, threads: [] }));
    }

    // Fetch threads with concurrency limit to stay under rate limit
    const CONCURRENCY = 5;
    const conversations: Conversation[] = [];
    for (let i = 0; i < allConversations.length; i += CONCURRENCY) {
      const batch = allConversations.slice(i, i + CONCURRENCY);
      const results = await Promise.all(
        batch.map(async (conv) => {
          const threads = await this.fetchThreads(conv.id);
          return { ...conv, threads } as Conversation;
        })
      );
      conversations.push(...results);
    }

    return conversations;
  }
}

/** Strip HTML tags from thread body text. */
export function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .trim();
}

/** Extract customer messages from a conversation's threads */
export function extractCustomerMessages(conv: Conversation): string[] {
  return conv.threads
    .filter((t) => t.createdBy.type === "customer" && t.body)
    .map((t) => stripHtml(t.body))
    .filter((text) => text.length > 0);
}
