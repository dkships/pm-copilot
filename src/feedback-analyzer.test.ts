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

  it("matches a regular plural of a single-word keyword", () => {
    // The bug this fixes: "what are your plans and prices?" matched nothing,
    // because `plan` and `pricing` are singular and the config listed plurals
    // only where someone happened to think of it.
    expect(matchesTheme("what are your plans and prices", ["plan", "price"])).toBe(true);
    expect(matchesTheme("difference between the tiers", ["tier"])).toBe(true);
  });

  it("matches an -es plural", () => {
    expect(matchesTheme("too many classes booked", ["class"])).toBe(true);
  });

  it("still refuses a match inside a longer word", () => {
    expect(matchesTheme("we need rapid responses", ["api"])).toBe(false);
    expect(matchesTheme("the planner is broken", ["plan"])).toBe(false);
  });

  it("matches multi-word keywords and their plural", () => {
    expect(matchesTheme("i need a time slot", ["time slot"])).toBe(true);
    expect(matchesTheme("i need time slots", ["time slot"])).toBe(true);
  });

  it("leaves irregular plurals to explicit keywords", () => {
    // entry/entries is why the giveaways theme lists both.
    expect(matchesTheme("how many entries do i get", ["entry"])).toBe(false);
    expect(matchesTheme("how many entries do i get", ["entry", "entries"])).toBe(true);
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

  it("gives threadCount 0 the same baseline severity as threadCount 1", () => {
    const zero = analyzeFeedback([conv(1, "billing invoice", { threadCount: 0 })], [], config);
    const one = analyzeFeedback([conv(1, "billing invoice", { threadCount: 1 })], [], config);
    const zeroBilling = zero.themes.find((t) => t.theme_id === "billing")!;
    const oneBilling = one.themes.find((t) => t.theme_id === "billing")!;
    expect(zeroBilling.severity_score).toBe(oneBilling.severity_score);
  });

  it("scores deeper threads as more severe (thread-count term is live)", () => {
    const shallow = analyzeFeedback([conv(1, "billing invoice", { threadCount: 1 })], [], config);
    const deep = analyzeFeedback([conv(1, "billing invoice", { threadCount: 3 })], [], config);
    const shallowBilling = shallow.themes.find((t) => t.theme_id === "billing")!;
    const deepBilling = deep.themes.find((t) => t.theme_id === "billing")!;
    expect(deepBilling.severity_score).toBeGreaterThan(shallowBilling.severity_score);
  });

  it("keeps scores finite when created_at is unparseable", () => {
    const r = analyzeFeedback([conv(1, "billing invoice", { createdAt: "not-a-date" })], [], config);
    const billing = r.themes.find((t) => t.theme_id === "billing")!;
    expect(Number.isFinite(billing.severity_score)).toBe(true);
    expect(Number.isFinite(billing.priority_score)).toBe(true);
  });

  it("clamps future-dated signals to at most the current-day recency boost", () => {
    const future = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    const fut = analyzeFeedback([conv(1, "billing invoice", { createdAt: future })], [], config);
    const current = analyzeFeedback([conv(1, "billing invoice", { createdAt: NOW })], [], config);
    const futBilling = fut.themes.find((t) => t.theme_id === "billing")!;
    const nowBilling = current.themes.find((t) => t.theme_id === "billing")!;
    expect(futBilling.severity_score).toBeLessThanOrEqual(nowBilling.severity_score + 0.01);
  });
});

// ── Scoring fixes ──

describe("severity scoring", () => {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const billingSeverity = (c: FormattedConversation) =>
    analyzeFeedback([c], [], config).themes.find((t) => t.theme_id === "billing")!.severity_score;

  it("halves the recency boost after 7 days, as documented", () => {
    const weekOld = new Date(Date.now() - 7 * DAY_MS).toISOString();
    // thread term 10 + recency 30 * 0.5
    expect(billingSeverity(conv(1, "billing", { createdAt: weekOld }))).toBeCloseTo(25, 1);
  });

  it("applies the highest matching tag boost regardless of tag order", () => {
    const a = billingSeverity(conv(1, "billing", { tags: ["bug", "escalation"] }));
    const b = billingSeverity(conv(1, "billing", { tags: ["escalation", "bug"] }));
    expect(a).toBe(b);
  });
});

describe("multi-word keyword matching", () => {
  it("does not match a phrase that starts or ends inside another word", () => {
    expect(matchesTheme("overtime slot usage", ["time slot"])).toBe(false);
    expect(matchesTheme("error 1500 error", ["500 error"])).toBe(false);
  });

  it("still matches the phrase and its plural", () => {
    expect(matchesTheme("pick a time slot", ["time slot"])).toBe(true);
    expect(matchesTheme("no time slots left", ["time slot"])).toBe(true);
  });
});

describe("feature request comments", () => {
  const comment = (role: string, text: string) => ({ role, comment: text, created_at: null });

  it("matches themes on customer comments but never on admin replies", () => {
    const withAdmin = feature("f1", "misc idea", { comments: [comment("admin", "billing is on our roadmap")] });
    const withCustomer = feature("f2", "misc idea", { comments: [comment("user", "billing please")] });
    const r = analyzeFeedback([], [withAdmin, withCustomer], config);
    const billing = r.themes.find((t) => t.theme_id === "billing");
    expect(billing?.data_points.map((d) => d.id)).toEqual(["pl-f2"]);
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

  it("does not surface PII-redaction placeholders as emerging themes", () => {
    const conversations = [
      conv(1, "zxqw problem", { preview: "reach me at [EMAIL REDACTED] about zxqw" }),
      conv(2, "zxqw again", { preview: "call [PHONE REDACTED] regarding zxqw" }),
      conv(3, "zxqw third", { preview: "my email [EMAIL REDACTED] bounced on zxqw" }),
    ];
    const r = analyzeFeedback(conversations, [], config);
    expect(r.unmatched_count).toBe(3);
    for (const e of r.emerging_themes) {
      expect(e.ngram).not.toMatch(/redacted/);
    }
  });
});
