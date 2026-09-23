import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ChatbaseClient, parseAgentConfigs, normalizeSourceFilter } from "./chatbase.js";

const AGENT = { name: "portal-a", agentId: "abc123" };

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

describe("parseAgentConfigs", () => {
  const saved = { ...process.env };
  beforeEach(() => {
    delete process.env.CHATBASE_AGENTS;
    delete process.env.CHATBASE_AGENT_ID;
    delete process.env.CHATBASE_AGENT_NAME;
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  it("parses the multi-agent form", () => {
    process.env.CHATBASE_AGENTS = "portal-a|abc123,portal-b|def456";
    expect(parseAgentConfigs()).toEqual([
      { name: "portal-a", agentId: "abc123" },
      { name: "portal-b", agentId: "def456" },
    ]);
  });

  it("trims whitespace and ignores empty entries", () => {
    process.env.CHATBASE_AGENTS = " portal-a | abc123 , ,portal-b|def456";
    expect(parseAgentConfigs()).toEqual([
      { name: "portal-a", agentId: "abc123" },
      { name: "portal-b", agentId: "def456" },
    ]);
  });

  it("throws on a malformed entry rather than silently dropping an agent", () => {
    process.env.CHATBASE_AGENTS = "portal-a";
    expect(() => parseAgentConfigs()).toThrow(/Expected "name\|agentId"/);
  });

  it("never echoes the raw entry, which may be a pasted key", () => {
    process.env.CHATBASE_AGENTS = "cb_SECRETKEY123";
    expect(() => parseAgentConfigs()).toThrow(/entry 1/);
    expect(() => parseAgentConfigs()).not.toThrow(/SECRET/);
  });

  it("falls back to the single-agent form", () => {
    process.env.CHATBASE_AGENT_ID = "abc123";
    process.env.CHATBASE_AGENT_NAME = "portal-a";
    expect(parseAgentConfigs()).toEqual([{ name: "portal-a", agentId: "abc123" }]);
  });

  it("defaults the single-agent name", () => {
    process.env.CHATBASE_AGENT_ID = "abc123";
    expect(parseAgentConfigs()).toEqual([{ name: "default", agentId: "abc123" }]);
  });

  it("returns no agents when nothing is configured", () => {
    expect(parseAgentConfigs()).toEqual([]);
  });

  it("prefers the multi-agent form over the single-agent form", () => {
    process.env.CHATBASE_AGENTS = "portal-a|abc123";
    process.env.CHATBASE_AGENT_ID = "ignored";
    expect(parseAgentConfigs()).toEqual([{ name: "portal-a", agentId: "abc123" }]);
  });
});

describe("normalizeSourceFilter", () => {
  it("trims tokens and canonicalizes case against the known source list", () => {
    expect(normalizeSourceFilter("whatsapp, widget or iframe")).toEqual({
      filter: "WhatsApp,Widget or Iframe",
      unknown: [],
    });
  });

  it("keeps unknown tokens as typed and reports them", () => {
    expect(normalizeSourceFilter("Playground,API")).toEqual({
      filter: "Playground,API",
      unknown: ["Playground"],
    });
  });

  it("drops empty tokens from a sloppy comma list", () => {
    expect(normalizeSourceFilter("API,,Slack,")).toEqual({
      filter: "API,Slack",
      unknown: [],
    });
  });
});

describe("ChatbaseClient.fetchConversations", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("sends the date window, agent id and bearer token", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: [] }));
    const client = new ChatbaseClient("secret-key", AGENT);
    await client.fetchConversations(30);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    const parsed = new URL(url as string);
    expect(parsed.pathname).toBe("/api/v1/get-conversations");
    expect(parsed.searchParams.get("chatbotId")).toBe("abc123");
    expect(parsed.searchParams.get("size")).toBe("50");
    expect(parsed.searchParams.get("page")).toBe("1");
    expect(parsed.searchParams.get("startDate")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(parsed.searchParams.get("endDate")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: "Bearer secret-key",
    });
    // No source filter requested — the parameter must not appear at all.
    expect(parsed.searchParams.has("filteredSources")).toBe(false);
  });

  it("passes filteredSources through as a query parameter when provided", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: [] }));
    const client = new ChatbaseClient("k", AGENT);
    await client.fetchConversations(30, "Widget or Iframe,WhatsApp");

    const [url] = fetchMock.mock.calls[0]!;
    const parsed = new URL(url as string);
    expect(parsed.searchParams.get("filteredSources")).toBe("Widget or Iframe,WhatsApp");
  });

  it("stops paginating on a short page", async () => {
    const full = Array.from({ length: 50 }, (_, i) => ({
      id: `c${i}`,
      created_at: new Date().toISOString(),
      messages: [],
    }));
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ data: full }))
      .mockResolvedValueOnce(jsonResponse({ data: [{ id: "last", created_at: "x", messages: [] }] }));

    const client = new ChatbaseClient("k", AGENT);
    const result = await client.fetchConversations(30);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result).toHaveLength(51);
  });

  it("accepts a bare array response as well as {data}", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse([{ id: "c1", created_at: new Date().toISOString(), messages: [] }])
    );
    const client = new ChatbaseClient("k", AGENT);
    expect(await client.fetchConversations(7)).toHaveLength(1);
  });

  it("names the plan gate on a 403 instead of a bare status", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ error: { code: "SUBSCRIPTION_API_RESTRICTED_PLAN" } }, { status: 403 })
    );
    const client = new ChatbaseClient("k", AGENT);
    await expect(client.fetchConversations(30)).rejects.toThrow(/Standard plan or higher/);
  });

  it("points at the API key on a 401", async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, { status: 401 }));
    const client = new ChatbaseClient("k", AGENT);
    await expect(client.fetchConversations(30)).rejects.toThrow(/CHATBASE_API_KEY/);
  });

  it("names the agent on a 404", async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, { status: 404 }));
    const client = new ChatbaseClient("k", AGENT);
    await expect(client.fetchConversations(30)).rejects.toThrow(/portal-a.*not found/);
  });

  it("retries a 429 honouring Retry-After, then succeeds", async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(
        new Response("rate limited", { status: 429, headers: { "retry-after": "1" } })
      )
      .mockResolvedValueOnce(jsonResponse({ data: [] }));

    const client = new ChatbaseClient("k", AGENT);
    const promise = client.fetchConversations(30);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(promise).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("gives up on a persistent 500 with the status in the message", async () => {
    vi.useFakeTimers();
    // A fresh Response per call — a real fetch never hands back a re-read body.
    fetchMock.mockImplementation(async () => new Response("boom", { status: 500 }));
    const client = new ChatbaseClient("k", AGENT);
    // Attach the handler before advancing timers so the rejection is never
    // momentarily unhandled while the backoff sleeps are being flushed.
    const settled = client.fetchConversations(30).catch((e: unknown) => e);
    await vi.runAllTimersAsync();
    const error = await settled;
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toMatch(/500/);
    // 1 initial attempt + MAX_RETRIES
    expect(fetchMock).toHaveBeenCalledTimes(4);
    vi.useRealTimers();
  });

  it("trims conversations the UTC-day date filter lets in from before the window", async () => {
    const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
    fetchMock.mockResolvedValue(
      jsonResponse({
        data: [
          { id: "in", created_at: hoursAgo(2), messages: [] },
          { id: "early", created_at: hoursAgo(30), messages: [] },
          { id: "undated", created_at: "not a date", messages: [] },
        ],
      })
    );
    const client = new ChatbaseClient("k", AGENT);
    const result = await client.fetchConversations(1);
    expect(result.map((c) => c.id)).toEqual(["in", "undated"]);
  });

  it("fails fast instead of sleeping through an absurd Retry-After", async () => {
    fetchMock.mockResolvedValue(
      new Response("rate limited", { status: 429, headers: { "retry-after": "86400" } })
    );
    const client = new ChatbaseClient("k", AGENT);
    await expect(client.fetchConversations(30)).rejects.toThrow(/rate limit/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("backs off long enough to clear the 10s rate window when no Retry-After is sent", async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(new Response("rate limited", { status: 429 }))
      .mockResolvedValueOnce(new Response("rate limited", { status: 429 }))
      .mockResolvedValueOnce(new Response("rate limited", { status: 429 }))
      .mockResolvedValueOnce(jsonResponse({ data: [] }));
    const client = new ChatbaseClient("k", AGENT);
    const promise = client.fetchConversations(30);
    // Three backoffs must add up to more than one 10s window.
    await vi.advanceTimersByTimeAsync(9_999);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(20_000);
    await expect(promise).resolves.toEqual([]);
    vi.useRealTimers();
  });
});

