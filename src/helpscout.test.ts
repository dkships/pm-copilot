import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { HelpScoutClient } from "./helpscout.js";

const TOKEN_URL = "https://api.helpscout.net/v2/oauth2/token";

const tokenResponse = () =>
  new Response(JSON.stringify({ access_token: "test-token", expires_in: 3600 }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

const mailboxesResponse = () =>
  new Response(
    JSON.stringify({
      _embedded: { mailboxes: [{ id: 1, name: "Support" }] },
      page: { totalElements: 1, totalPages: 1, number: 1, size: 50 },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );

const rateLimited = (headers: Record<string, string> = {}) =>
  new Response("Too Many Requests", { status: 429, headers });

/** Stub fetch: token endpoint always succeeds, API calls consume the queue. */
function stubFetchSequence(apiResponses: Response[]) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    if (String(input) === TOKEN_URL) return tokenResponse();
    const next = apiResponses.shift();
    if (!next) throw new Error("fetch called more times than expected");
    return next;
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const apiCalls = (fetchMock: ReturnType<typeof vi.fn>) =>
  fetchMock.mock.calls.filter((call) => String(call[0]) !== TOKEN_URL).length;

describe("HelpScoutClient 429 retry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("waits X-RateLimit-Retry-After seconds before retrying", async () => {
    const fetchMock = stubFetchSequence([
      rateLimited({ "X-RateLimit-Retry-After": "7" }),
      mailboxesResponse(),
    ]);
    const client = new HelpScoutClient("id", "secret");
    const promise = client.fetchMailboxes();

    await vi.advanceTimersByTimeAsync(0);
    expect(apiCalls(fetchMock)).toBe(1);

    await vi.advanceTimersByTimeAsync(6_999);
    expect(apiCalls(fetchMock)).toBe(1);

    await vi.advanceTimersByTimeAsync(1);
    await expect(promise).resolves.toEqual([{ id: 1, name: "Support" }]);
    expect(apiCalls(fetchMock)).toBe(2);
  });

  it("falls back to exponential backoff when no retry header is present", async () => {
    const fetchMock = stubFetchSequence([rateLimited(), mailboxesResponse()]);
    const client = new HelpScoutClient("id", "secret");
    const promise = client.fetchMailboxes();

    await vi.advanceTimersByTimeAsync(0);
    expect(apiCalls(fetchMock)).toBe(1);

    // First backoff step is RETRY_BACKOFF_MS (15s)
    await vi.advanceTimersByTimeAsync(14_999);
    expect(apiCalls(fetchMock)).toBe(1);

    await vi.advanceTimersByTimeAsync(1);
    await expect(promise).resolves.toEqual([{ id: 1, name: "Support" }]);
    expect(apiCalls(fetchMock)).toBe(2);
  });

  it("throws after exhausting MAX_429_RETRIES on persistent 429s", async () => {
    const fetchMock = stubFetchSequence([
      rateLimited({ "X-RateLimit-Retry-After": "1" }),
      rateLimited({ "X-RateLimit-Retry-After": "1" }),
      rateLimited({ "X-RateLimit-Retry-After": "1" }),
      rateLimited({ "X-RateLimit-Retry-After": "1" }),
    ]);
    const client = new HelpScoutClient("id", "secret");
    const promise = client.fetchMailboxes();
    const assertion = expect(promise).rejects.toThrow(
      /rate limit exceeded on \/mailboxes after 3 retries/
    );

    await vi.runAllTimersAsync();
    await assertion;
    expect(apiCalls(fetchMock)).toBe(4);
  });

  it("uses backoff instead of an instant retry when the header is non-numeric", async () => {
    const fetchMock = stubFetchSequence([
      rateLimited({ "X-RateLimit-Retry-After": "soon" }),
      mailboxesResponse(),
    ]);
    const client = new HelpScoutClient("id", "secret");
    const promise = client.fetchMailboxes();

    await vi.advanceTimersByTimeAsync(0);
    expect(apiCalls(fetchMock)).toBe(1);

    // NaN * 1000 must not turn into setTimeout(NaN) (an instant retry)
    await vi.advanceTimersByTimeAsync(1_000);
    expect(apiCalls(fetchMock)).toBe(1);

    await vi.advanceTimersByTimeAsync(14_000);
    await expect(promise).resolves.toEqual([{ id: 1, name: "Support" }]);
    expect(apiCalls(fetchMock)).toBe(2);
  });
});
