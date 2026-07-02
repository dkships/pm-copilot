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
