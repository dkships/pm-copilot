import { describe, it, expect } from "vitest";
import {
  analyzeFeedback,
  matchesTheme,
  type ThemesConfig,
  type FormattedConversation,
  type FormattedFeatureRequest,
} from "./feedback-analyzer.js";

// ── Fixtures ──

const config: ThemesConfig = {
  version: 2,
  themes: [
    { id: "billing", label: "Billing", keywords: ["billing", "invoice"], category: "billing" },
    { id: "api", label: "API", keywords: ["api"], category: "integration" },
    { id: "booking", label: "Booking", keywords: ["time slot"], category: "core" },
  ],
  stop_words: ["the", "a", "to", "and", "is", "we", "need", "with"],
  emerging_theme_min_frequency: 2,
};

const NOW = new Date().toISOString();

function conv(
  id: number,
  subject: string,
  opts: Partial<FormattedConversation> = {}
): FormattedConversation {
  return {
    id,
    number: id,
    subject,
    status: "active",
    createdAt: NOW,
    closedAt: null,
    customerEmail: "[REDACTED]",
    tags: [],
    preview: "",
    customerMessages: [],
    threadCount: 1,
    ...opts,
  };
}

function feature(
  id: string,
  title: string,
  opts: Partial<FormattedFeatureRequest> = {}
): FormattedFeatureRequest {
  return {
    id,
    title,
    description: "",
    status: "open",
    category: null,
    votes_count: 0,
    comments_count: 0,
    portal: "test",
    created_at: NOW,
    updated_at: NOW,
    comments: [],
    ...opts,
  };
}

// ── matchesTheme ──

describe("matchesTheme", () => {
  it("matches a multi-word keyword as a substring", () => {
    expect(matchesTheme("i want a custom time slot please", ["time slot"])).toBe(true);
  });

  it("matches a single-word keyword on a word boundary", () => {
    expect(matchesTheme("the api broke today", ["api"])).toBe(true);
  });

  it("does NOT match a single-word keyword inside another word", () => {
    expect(matchesTheme("we need rapid responses", ["api"])).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(matchesTheme("BILLING is wrong", ["billing"])).toBe(true);
  });

  it("returns false when no keyword is present", () => {
    expect(matchesTheme("everything is fine", ["billing", "api"])).toBe(false);
  });
});

// ── analyzeFeedback: counts, convergence, sorting ──

describe("analyzeFeedback", () => {
  it("handles empty inputs", () => {
    const r = analyzeFeedback([], [], config);
    expect(r.total_data_points).toBe(0);
    expect(r.themes).toEqual([]);
    expect(r.emerging_themes).toEqual([]);
    expect(r.unmatched_count).toBe(0);
    expect(r.known_themes_count).toBe(3);
  });

  it("flags a theme convergent when it appears in both sources and applies the 2x boost", () => {
    const conversations = [conv(1, "billing issue with my invoice")];
    const features = [feature("a", "billing export", { votes_count: 10 })];
    const r = analyzeFeedback(conversations, features, config);

    const billing = r.themes.find((t) => t.theme_id === "billing");
    expect(billing).toBeDefined();
    expect(billing!.convergent).toBe(true);
    expect(billing!.reactive_count).toBe(1);
    expect(billing!.proactive_count).toBe(1);

    // priority = (freq*.35 + sev*.35 + vote*.3) * 2  (convergence boost)
    const base =
      billing!.frequency_score * 0.35 +
      billing!.severity_score * 0.35 +
      billing!.vote_momentum_score * 0.3;
    expect(billing!.priority_score).toBeCloseTo(Math.round(base * 2 * 100) / 100, 1);
  });

  it("does not flag a single-source theme convergent", () => {
    const r = analyzeFeedback([], [feature("a", "api access please", { votes_count: 5 })], config);
    const api = r.themes.find((t) => t.theme_id === "api");
    expect(api).toBeDefined();
    expect(api!.convergent).toBe(false);
    expect(api!.reactive_count).toBe(0);
    expect(api!.proactive_count).toBe(1);
  });

  it("sorts themes by priority_score descending", () => {
    const conversations = [
      conv(1, "billing invoice problem"),
      conv(2, "another billing invoice problem"),
    ];
    const features = [
      feature("a", "billing plan change", { votes_count: 50 }),
      feature("b", "api token rotation", { votes_count: 1 }),
    ];
    const r = analyzeFeedback(conversations, features, config);
    const scores = r.themes.map((t) => t.priority_score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
  });

  it("scores severity from reactive signals only; vote momentum from proactive only", () => {
    const reactiveOnly = analyzeFeedback([conv(1, "billing invoice error")], [], config);
    const billingR = reactiveOnly.themes.find((t) => t.theme_id === "billing")!;
    expect(billingR.severity_score).toBeGreaterThan(0);
    expect(billingR.vote_momentum_score).toBe(0);

    const proactiveOnly = analyzeFeedback([], [feature("a", "billing upgrade", { votes_count: 9 })], config);
    const billingP = proactiveOnly.themes.find((t) => t.theme_id === "billing")!;
    expect(billingP.severity_score).toBe(0);
    expect(billingP.vote_momentum_score).toBeGreaterThan(0);
  });

  it("caps scores within bounds", () => {
    const conversations = [conv(1, "billing invoice", { threadCount: 100 })];
    const r = analyzeFeedback(conversations, [], config);
    const billing = r.themes.find((t) => t.theme_id === "billing")!;
    expect(billing.severity_score).toBeLessThanOrEqual(100);
    expect(billing.frequency_score).toBeLessThanOrEqual(100);
  });

  it("counts unmatched data points", () => {
    const r = analyzeFeedback([conv(1, "something totally unrelated zxqw")], [], config);
    expect(r.unmatched_count).toBe(1);
    expect(r.themes).toEqual([]);
  });
});

// ── Emerging theme detection ──

describe("emerging themes", () => {
  it("detects a repeated n-gram among unmatched points above min frequency", () => {
    const conversations = [
      conv(1, "dark mode missing everywhere"),
      conv(2, "please add dark mode option"),
      conv(3, "dark mode would be great"),
    ];
    const r = analyzeFeedback(conversations, [], config);
    expect(r.unmatched_count).toBe(3);
    const darkMode = r.emerging_themes.find((e) => e.ngram.includes("dark mode"));
    expect(darkMode).toBeDefined();
    expect(darkMode!.frequency).toBeGreaterThanOrEqual(config.emerging_theme_min_frequency);
  });

  it("ignores n-grams below the minimum frequency", () => {
    const r = analyzeFeedback([conv(1, "singular unmatched phrase zxqw")], [], config);
    expect(r.emerging_themes).toEqual([]);
  });
});
