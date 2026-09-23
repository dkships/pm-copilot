import { describe, it, expect, afterEach, vi } from "vitest";
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

    const { requests } = await client.fetchFeatureRequests(true, "planned");

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

    const { requests } = await client.fetchFeatureRequests(true);

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
    await client().fetchFeatureRequests(true);
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
    const result = await client().fetchFeatureRequests(true);
    expect(result.requests).toHaveLength(1);
    expect(result.commentFailures).toBe(1);
  });
});
