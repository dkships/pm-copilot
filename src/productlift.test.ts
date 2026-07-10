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

    const requests = await client.fetchFeatureRequests(true, "planned");

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

    const requests = await client.fetchFeatureRequests(true);

    expect(requests).toHaveLength(2);
    const commentUrls = fetchMock.mock.calls
      .map((call) => String(call[0]))
      .filter((url) => url.includes("/comments"));
    expect(commentUrls).toHaveLength(2);
  });
});
