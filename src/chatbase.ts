/**
 * Chatbase client — AI support agent conversations, the deflection signal.
 *
 * Uses the v1 `/get-conversations` endpoint rather than v2 `/conversations/export`.
 * v1 filters server-side by date (matching this server's `timeframe_days`) and
 * paginates with page/size; v2 has no date filter, caps at 20 per page, and only
 * paginates by opaque cursor. v1 also returns `min_score`, which v2's per-message
 * `feedback` field does not replace in practice — thumbs feedback is almost never
 * populated on real widget traffic.
 *
 * Both API versions need a Chatbase Standard plan or higher.
 */

const PAGE_SIZE = 50;
const REQUEST_TIMEOUT_MS = 30_000;
// Backstop against an endpoint that never reports a short page. 200 pages at
// PAGE_SIZE is far beyond any real 90-day window.
const MAX_PAGES = 200;
const MAX_RETRIES = 3;
// Chatbase's rate window is 10 seconds; a longer ask fails fast rather than
// hanging the tool call.
const MAX_RETRY_WAIT_MS = 30_000;
const DAY_MS = 86_400_000;

const API_BASE = "https://www.chatbase.co/api/v1";

/**
 * Source types the v1 `filteredSources` query parameter accepts, per the
 * Chatbase docs. Hard-coded — the API has no endpoint to enumerate them.
 */
export const CHATBASE_CONVERSATION_SOURCES = [
  "API",
  "Chatbase site",
  "Instagram",
  "Messenger",
  "Slack",
  "Unspecified",
  "WhatsApp",
  "Widget or Iframe",
] as const;

/**
 * Normalize a user-supplied source filter: split on commas, trim each token,
 * and canonicalize casing against CHATBASE_CONVERSATION_SOURCES ("whatsapp" →
 * "WhatsApp"). Tokens the list does not cover — "Playground", "unknown", typos —
 * are kept as typed, since the API may accept values the list has not caught up
 * with, and reported back so the caller can warn instead of letting a wrong
 * value silently match zero conversations.
 */
export function normalizeSourceFilter(filter: string): {
  filter: string;
  unknown: string[];
} {
  const canonical = new Map(
    CHATBASE_CONVERSATION_SOURCES.map((s) => [s.toLowerCase(), s] as const)
  );
  const unknown: string[] = [];
  const normalized = filter
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .map((t) => {
      const match = canonical.get(t.toLowerCase());
      if (match) return match;
      unknown.push(t);
      return t;
    });
  return { filter: normalized.join(","), unknown };
}

export interface AgentConfig {
  name: string;
  agentId: string;
}

export interface ChatbaseMessage {
  id?: string;
  /** "user" or "assistant" — structured attribution, so no heuristics needed. */
  role: string;
  type?: string;
  content: string;
  createdAt?: string;
}

export interface ChatbaseConversation {
  id: string;
  /** "Widget or Iframe", "API", "WhatsApp", "Playground", … */
  source?: string | null;
  /**
   * Lowest answer confidence across the conversation, 0–1. Chatbase does not
   * document what this measures; treated here as "the agent was unsure somewhere
   * in this conversation" and surfaced as evidence, never folded into scoring.
   */
  min_score?: number | null;
  created_at: string;
  last_message_at?: string | null;
  messages?: ChatbaseMessage[];
}

interface ConversationsResponse {
  data: ChatbaseConversation[];
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export class ChatbaseClient {
  private apiKey: string;
  private agent: AgentConfig;

  constructor(apiKey: string, agent: AgentConfig) {
    this.apiKey = apiKey;
    this.agent = agent;
  }

  get agentName(): string {
    return this.agent.name;
  }

  get agentId(): string {
    return this.agent.agentId;
  }

  private async apiGet<T>(path: string, params: Record<string, string>): Promise<T> {
    const url = new URL(`${API_BASE}${path}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

    let lastError = "";
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const res = await fetch(url.toString(), {
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (res.status === 401) {
        throw new Error(
          `Chatbase auth failed (401) for agent "${this.agent.name}": ` +
            "check CHATBASE_API_KEY in .env."
        );
      }

      if (res.status === 403) {
        throw new Error(
          `Chatbase rejected the request (403) for agent "${this.agent.name}": ` +
            "API access needs a Chatbase Standard plan or higher."
        );
      }

      if (res.status === 404) {
        throw new Error(
          `Chatbase agent "${this.agent.name}" (${this.agent.agentId}) not found (404): ` +
            "check the agent id, and that the API key belongs to the same account."
        );
      }

      // 100 requests per 10-second window, per key and IP. Honour Retry-After
      // when present, otherwise back off.
      if (res.status === 429 && attempt < MAX_RETRIES) {
        const header = Number(res.headers.get("retry-after"));
        const waitMs = Number.isFinite(header) && header > 0
          ? header * 1000
          : 1000 * 2 ** attempt;
        if (waitMs > MAX_RETRY_WAIT_MS) {
          throw new Error(
            `Chatbase rate limit for agent "${this.agent.name}": asked to wait ${Math.round(waitMs / 1000)}s`
          );
        }
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }

      if (!res.ok) {
        lastError = `Chatbase API error (${res.status}) for agent "${this.agent.name}" on ${path}: ${await res.text()}`;
        if (res.status >= 500 && attempt < MAX_RETRIES) {
          await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
          continue;
        }
        throw new Error(lastError);
      }

      return (await res.json()) as T;
    }

    throw new Error(lastError || `Chatbase request failed for agent "${this.agent.name}" on ${path}`);
  }

  /**
   * Fetch conversations in the timeframe. The API filters by whole UTC days,
   * so the request asks for a day either side and results are trimmed here
   * to the exact window the other sources use. Undated conversations are
   * kept — the server already placed them in range.
   * `filteredSources` is a comma-separated list of source types (see
   * CHATBASE_CONVERSATION_SOURCES), also applied server-side.
   */
  async fetchConversations(
    timeframeDays: number,
    filteredSources?: string
  ): Promise<ChatbaseConversation[]> {
    const now = Date.now();
    const start = new Date(now - timeframeDays * DAY_MS);
    // endDate may be exclusive; tomorrow's date keeps today's chats either way.
    const end = new Date(now + DAY_MS);

    const all: ChatbaseConversation[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const body = await this.apiGet<ConversationsResponse | ChatbaseConversation[]>(
        "/get-conversations",
        {
          chatbotId: this.agent.agentId,
          startDate: isoDate(start),
          endDate: isoDate(end),
          page: String(page),
          size: String(PAGE_SIZE),
          ...(filteredSources ? { filteredSources } : {}),
        }
      );

      const batch = Array.isArray(body) ? body : (body.data ?? []);
      all.push(...batch);
      if (batch.length < PAGE_SIZE) break;
    }

    return all.filter((c) => {
      const createdMs = new Date(c.created_at).getTime();
      return !Number.isFinite(createdMs) || createdMs >= start.getTime();
    });
  }
}

/**
 * Parse agent configs from the environment.
 * Multi-agent: CHATBASE_AGENTS="portal-a|abc123,portal-b|def456"
 * Single agent: CHATBASE_AGENT_ID (+ optional CHATBASE_AGENT_NAME)
 * Both need CHATBASE_API_KEY, which is account-wide.
 */
export function parseAgentConfigs(): AgentConfig[] {
  const agents = process.env.CHATBASE_AGENTS;
  if (agents) {
    return agents
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
      .map((entry, index) => {
        const parts = entry.split("|");
        const name = parts[0]?.trim();
        const agentId = parts[1]?.trim();
        if (!name || !agentId) {
          // Don't echo the entry: a mis-pasted API key would land in tool
          // descriptions and list_sources.
          throw new Error(
            `Invalid CHATBASE_AGENTS format in entry ${index + 1}. ` +
              'Expected "name|agentId" per entry.'
          );
        }
        return { name, agentId };
      });
  }

  const agentId = process.env.CHATBASE_AGENT_ID?.trim();
  const name = process.env.CHATBASE_AGENT_NAME?.trim() || "default";
  if (agentId) return [{ name, agentId }];

  return [];
}
