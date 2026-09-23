import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { parsePortalConfigs, ProductLiftClient } from "./productlift.js";

function stubNoPortalEnv() {
  // undefined deletes the var — "" would not be nullish for the ?? fallbacks
  vi.stubEnv("PRODUCTLIFT_PORTALS", undefined);
  vi.stubEnv("PRODUCTLIFT_PORTAL_URL", undefined);
  vi.stubEnv("PRODUCTLIFT_API_KEY", undefined);
  vi.stubEnv("PRODUCTLIFT_PORTAL_NAME", undefined);
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("parsePortalConfigs", () => {
  it("parses multiple portals from PRODUCTLIFT_PORTALS", () => {
    vi.stubEnv(
      "PRODUCTLIFT_PORTALS",
      "acme|https://roadmap.acme.com|key-a,beta|https://roadmap.beta.com|key-b"
    );
    const configs = parsePortalConfigs();
    expect(configs).toEqual([
      { name: "acme", baseUrl: "https://roadmap.acme.com", apiKey: "key-a" },
      { name: "beta", baseUrl: "https://roadmap.beta.com", apiKey: "key-b" },
    ]);
  });

  it("rejoins pipes inside the API key", () => {
    vi.stubEnv("PRODUCTLIFT_PORTALS", "acme|https://roadmap.acme.com|key|with|pipes");
    const configs = parsePortalConfigs();
    expect(configs[0]?.apiKey).toBe("key|with|pipes");
  });

  it("trims whitespace around fields", () => {
    vi.stubEnv("PRODUCTLIFT_PORTALS", " acme | https://roadmap.acme.com | key-a ");
    const configs = parsePortalConfigs();
    expect(configs[0]).toEqual({
      name: "acme",
      baseUrl: "https://roadmap.acme.com",
      apiKey: "key-a",
    });
  });

  it("strips a trailing slash from the base URL", () => {
    vi.stubEnv("PRODUCTLIFT_PORTALS", "acme|https://roadmap.acme.com/|key-a");
    expect(parsePortalConfigs()[0]?.baseUrl).toBe("https://roadmap.acme.com");
  });

  it("throws an actionable error on a malformed entry", () => {
    vi.stubEnv("PRODUCTLIFT_PORTALS", "acme|https://roadmap.acme.com");
    expect(() => parsePortalConfigs()).toThrow(/Invalid PRODUCTLIFT_PORTALS format/);
  });

  it("never echoes the API key in a malformed-entry error", () => {
    vi.stubEnv("PRODUCTLIFT_PORTALS", "acme||sk-live-SECRET");
    expect(() => parsePortalConfigs()).toThrow(/entry 1/);
    expect(() => parsePortalConfigs()).not.toThrow(/SECRET/);
  });

  it("never echoes a key-only entry as a portal name", () => {
    vi.stubEnv("PRODUCTLIFT_PORTALS", "pl_SECRETKEY123");
    expect(() => parsePortalConfigs()).not.toThrow(/SECRET/);
  });

  it("falls back to single-portal env vars with a default name", () => {
    stubNoPortalEnv();
    vi.stubEnv("PRODUCTLIFT_PORTAL_URL", "https://roadmap.example.com/");
    vi.stubEnv("PRODUCTLIFT_API_KEY", "single-key");
    const configs = parsePortalConfigs();
    expect(configs).toEqual([
      { name: "default", baseUrl: "https://roadmap.example.com", apiKey: "single-key" },
    ]);
  });

  it("uses PRODUCTLIFT_PORTAL_NAME for the single-portal name when set", () => {
    stubNoPortalEnv();
    vi.stubEnv("PRODUCTLIFT_PORTAL_URL", "https://roadmap.example.com");
    vi.stubEnv("PRODUCTLIFT_API_KEY", "single-key");
    vi.stubEnv("PRODUCTLIFT_PORTAL_NAME", "acme");
    expect(parsePortalConfigs()[0]?.name).toBe("acme");
  });

  it("returns an empty list when nothing is configured", () => {
    stubNoPortalEnv();
    expect(parsePortalConfigs()).toEqual([]);
  });
});

describe("ProductLiftClient", () => {
  it("exposes the portal name without exposing the config", () => {
    const client = new ProductLiftClient({
      name: "acme",
      baseUrl: "https://roadmap.acme.com",
      apiKey: "secret",
    });
    expect(client.portalName).toBe("acme");
  });
});

describe("fetchFeatureRequests status pre-filter", () => {
  const jsonResponse = (body: unknown) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

  const makePost = (
    id: string,
    status: { id: number; name: string; color: string } | null
  ) => ({
    id,
    title: `Post ${id}`,
    description: "",
    status,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("skips comment fetches for posts whose status fails the filter", async () => {
    const posts = [
      makePost("1", { id: 1, name: "Planned", color: "#00f" }),
      makePost("2", { id: 2, name: "Open", color: "#0f0" }),
      makePost("3", null),
    ];

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/comments")) {
        return jsonResponse({ data: [] });
      }
      return jsonResponse({
        data: posts,
        hasMore: false,
        total: posts.length,
        skip: 0,
        limit: 10,
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new ProductLiftClient({
      name: "acme",
      baseUrl: "https://roadmap.acme.com",
      apiKey: "secret",
    });

    const { requests } = await client.fetchFeatureRequests({ includeComments: true, status: "planned" });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.id).toBe("1");

    const commentUrls = fetchMock.mock.calls
      .map((call) => String(call[0]))
      .filter((url) => url.includes("/comments"));
    expect(commentUrls).toEqual([
      "https://roadmap.acme.com/api/v1/posts/1/comments",
    ]);
  });

  it("fetches comments for every post when no status filter is given", async () => {
    const posts = [
      makePost("1", { id: 1, name: "Planned", color: "#00f" }),
      makePost("2", null),
    ];

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/comments")) {
        return jsonResponse({ data: [] });
      }
      return jsonResponse({
        data: posts,
        hasMore: false,
        total: posts.length,
        skip: 0,
        limit: 10,
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new ProductLiftClient({
      name: "acme",
      baseUrl: "https://roadmap.acme.com",
      apiKey: "secret",
    });

    const { requests } = await client.fetchFeatureRequests({ includeComments: true });

    expect(requests).toHaveLength(2);
    const commentUrls = fetchMock.mock.calls
      .map((call) => String(call[0]))
      .filter((url) => url.includes("/comments"));
    expect(commentUrls).toHaveLength(2);
  });
});

describe("ProductLiftClient resilience", () => {
  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json", ...headers },
    });

  const page = (data: unknown[], hasMore = false) => ({
    data,
    hasMore,
    total: data.length,
    skip: 0,
    limit: 10,
  });

  const post = (id: string, comments_count?: number) => ({
    id,
    title: `Post ${id}`,
    description: "",
    status: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...(comments_count === undefined ? {} : { comments_count }),
  });

  const client = () =>
    new ProductLiftClient({ name: "acme", baseUrl: "https://roadmap.acme.com", apiKey: "k" });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("retries a 429 on the posts endpoint instead of failing the portal", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls++;
        if (calls === 1) {
          return json({}, 429, { "retry-after": "0.01" });
        }
        return json(page([post("1")]));
      })
    );
    const posts = await client().fetchPosts();
    expect(posts).toHaveLength(1);
    expect(calls).toBe(2);
  });

  it("stops paging when the API never reports the last page", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json(page([post("x")], true)))
    );
    await expect(client().fetchPosts({ maxPages: 3, pageDelayMs: 0 })).rejects.toThrow(
      /more than 3 pages/
    );
  });

  it("fails the portal instead of caching a truncated list on a malformed page", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls++;
        return calls === 1
          ? json(page([post("1")], true))
          : json({ error: "upstream", hasMore: true });
      })
    );
    await expect(client().fetchPosts({ pageDelayMs: 0 })).rejects.toThrow(/malformed/);
  });

  it("reuses the post list across calls within the cache window", async () => {
    const fetchMock = vi.fn(async () => json(page([post("1")])));
    vi.stubGlobal("fetch", fetchMock);
    const c = client();
    await c.fetchPosts();
    await c.fetchPosts();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("skips comment calls for posts that report zero comments", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) =>
      String(input).includes("/comments")
        ? json({ data: [] })
        : json(page([post("1", 0), post("2", 3), post("3")]))
    );
    vi.stubGlobal("fetch", fetchMock);
    await client().fetchFeatureRequests({ includeComments: true });
    const commentUrls = fetchMock.mock.calls
      .map((call) => String(call[0]))
      .filter((url) => url.includes("/comments"));
    expect(commentUrls).toEqual([
      "https://roadmap.acme.com/api/v1/posts/2/comments",
      "https://roadmap.acme.com/api/v1/posts/3/comments",
    ]);
  });

  it("counts comment fetch failures instead of hiding them", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) =>
        String(input).includes("/comments")
          ? json({ error: "boom" }, 500)
          : json(page([post("1", 2)]))
      )
    );
    const result = await client().fetchFeatureRequests({ includeComments: true });
    expect(result.requests).toHaveLength(1);
    expect(result.commentFailures).toBe(1);
  });

  it("attaches comments to a given subset of posts", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) =>
      String(input).includes("/comments")
        ? json({ data: [{ id: 1, comment: "same here", author: { id: "u", name: "N", role: "user" } }] })
        : json(page([]))
    );
    vi.stubGlobal("fetch", fetchMock);
    const result = await client().withComments([post("7", 1), post("8", 0)]);
    expect(result.requests.map((r) => [r.id, r.comments.length])).toEqual([
      ["7", 1],
      ["8", 0],
    ]);
    expect(result.requests[0]?.portal).toBe("acme");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("fetchPosts parallel paging", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const client = () =>
    new ProductLiftClient({ name: "acme", baseUrl: "https://r.example.com", apiKey: "k" });

  // Serves `total` posts in pages of 10, reporting `reportedTotal`.
  function stubPortal(total: number, reportedTotal = total) {
    let inFlight = 0;
    const stats = { maxInFlight: 0, skips: [] as number[] };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const skip = Number(new URL(String(input)).searchParams.get("skip"));
        stats.skips.push(skip);
        inFlight++;
        stats.maxInFlight = Math.max(stats.maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 10));
        inFlight--;
        const data = Array.from({ length: Math.max(0, Math.min(10, total - skip)) }, (_, i) => ({
          id: String(skip + i),
          title: "",
          description: "",
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:00:00Z",
        }));
        return new Response(
          JSON.stringify({ data, hasMore: skip + data.length < total, total: reportedTotal, skip, limit: 10 }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      })
    );
    return stats;
  }

  it("fetches the remaining pages in parallel, in order", async () => {
    const stats = stubPortal(35);
    const posts = await client().fetchPosts({ pageDelayMs: 0 });
    expect(posts.map((p) => p.id)).toEqual(Array.from({ length: 35 }, (_, i) => String(i)));
    expect(stats.maxInFlight).toBeGreaterThan(1);
  });

  it("keeps paging sequentially when more posts exist than the first page reported", async () => {
    stubPortal(25, 12);
    const posts = await client().fetchPosts({ pageDelayMs: 0 });
    expect(posts).toHaveLength(25);
  });
});

describe("fetchPosts paging edge cases", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const client = () =>
    new ProductLiftClient({ name: "acme", baseUrl: "https://r.example.com", apiKey: "k" });

  const postsAt = (skip: number, count: number) =>
    Array.from({ length: count }, (_, i) => ({
      id: `p${skip + i}`,
      title: "",
      description: "",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    }));

  const respond = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

  it("stops claiming new pages once one page fails", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const skip = Number(new URL(String(input)).searchParams.get("skip"));
      if (skip === 20) {
        return respond({ error: "boom" }, 500);
      }
      await new Promise((r) => setTimeout(r, 5));
      return respond({ data: postsAt(skip, 10), hasMore: true, total: 500, skip, limit: 10 });
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(client().fetchPosts({ pageDelayMs: 0 })).rejects.toThrow(/500/);
    await new Promise((r) => setTimeout(r, 100));
    expect(fetchMock.mock.calls.length).toBeLessThan(15);
  });

  it("does not skip posts when a short first page understates the total", async () => {
    // 60 real posts, total reported as 21, a short first page (7) and full
    // pages (10) after it, so the parallel pages overlap.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const skip = Number(new URL(String(input)).searchParams.get("skip"));
        const size = skip === 0 ? 7 : 10;
        const data = postsAt(skip, Math.max(0, Math.min(size, 60 - skip)));
        return respond({ data, hasMore: skip + data.length < 60, total: 21, skip, limit: 10 });
      })
    );
    const posts = await client().fetchPosts({ pageDelayMs: 0 });
    expect(posts.map((p) => p.id)).toEqual(Array.from({ length: 60 }, (_, i) => `p${i}`));
  });

  it("rejects an absurd total before planning the pages", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => respond({ data: postsAt(0, 10), hasMore: true, total: 1e9, skip: 0, limit: 10 }))
    );
    await expect(client().fetchPosts({ pageDelayMs: 0 })).rejects.toThrow(/more than 500 pages/);
  });
});

describe("withComments concurrency", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetches comments several at a time and keeps post order", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 20));
        inFlight--;
        return new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      })
    );
    const posts = Array.from({ length: 8 }, (_, i) => ({
      id: String(i),
      title: `p${i}`,
      description: "",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
      comments_count: 1,
    }));
    const client = new ProductLiftClient({ name: "acme", baseUrl: "https://r.example.com", apiKey: "k" });
    const { requests } = await client.withComments(posts);
    expect(requests.map((r) => r.id)).toEqual(["0", "1", "2", "3", "4", "5", "6", "7"]);
    expect(maxInFlight).toBeGreaterThan(1);
    expect(maxInFlight).toBeLessThanOrEqual(6);
  });
});

describe("fetchFeatureRequests limit and sort", () => {
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

  const posts = [
    { id: "old-popular", votes_count: 90, created_at: "2026-01-01T00:00:00Z" },
    { id: "new-quiet", votes_count: 1, created_at: "2026-09-01T00:00:00Z" },
    { id: "mid", votes_count: 40, created_at: "2026-05-01T00:00:00Z" },
  ].map((p) => ({ ...p, title: p.id, description: "", status: null, updated_at: p.created_at, comments_count: 2 }));

  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async (input: RequestInfo | URL) =>
      String(input).includes("/comments")
        ? json({ data: [] })
        : json({ data: posts, hasMore: false, total: posts.length, skip: 0, limit: 10 })
    );
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const client = () =>
    new ProductLiftClient({ name: "acme", baseUrl: "https://roadmap.acme.com", apiKey: "k" });

  it("sorts by votes and keeps the top N", async () => {
    const { requests } = await client().fetchFeatureRequests({ limit: 2, sort: "votes" });
    expect(requests.map((r) => r.id)).toEqual(["old-popular", "mid"]);
  });

  it("sorts by recency and keeps the top N", async () => {
    const { requests } = await client().fetchFeatureRequests({ limit: 1, sort: "recent" });
    expect(requests.map((r) => r.id)).toEqual(["new-quiet"]);
  });

  it("fetches comments only for posts that survive the limit", async () => {
    await client().fetchFeatureRequests({ includeComments: true, limit: 1, sort: "votes" });
    const commentUrls = fetchMock.mock.calls
      .map((call) => String(call[0]))
      .filter((url) => url.includes("/comments"));
    expect(commentUrls).toEqual(["https://roadmap.acme.com/api/v1/posts/old-popular/comments"]);
  });

  it("keeps API order when no sort is given", async () => {
    const { requests } = await client().fetchFeatureRequests({});
    expect(requests.map((r) => r.id)).toEqual(["old-popular", "new-quiet", "mid"]);
  });
});
