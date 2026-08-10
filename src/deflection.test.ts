import { describe, it, expect } from "vitest";
import { formatDeflectedConversation, buildEvidenceSummary, signalTypeOf, extractQuotesForTheme, buildLookupMaps, trimAnalysisForDetail } from "./format.js";
import { analyzeFeedback } from "./feedback-analyzer.js";
import type { ChatbaseConversation } from "./chatbase.js";
import type {
  ThemesConfig,
  FormattedDeflectedConversation,
  ThemeMatch,
} from "./feedback-analyzer.js";

const config: ThemesConfig = {
  version: 1,
  themes: [
    { id: "billing", label: "Billing", keywords: ["refund", "invoice"], category: "billing" },
    { id: "booking", label: "Booking", keywords: ["booking"], category: "core" },
  ],
  stop_words: [],
  emerging_theme_min_frequency: 3,
};

function rawConv(overrides: Partial<ChatbaseConversation> = {}): ChatbaseConversation {
  return {
    id: "conv-1",
    source: "Widget or Iframe",
    min_score: 0.42,
    created_at: "2026-08-01T10:00:00Z",
    messages: [
      { id: "m1", role: "user", content: "I need a refund", createdAt: "2026-08-01T10:00:00Z" },
      { id: "m2", role: "assistant", content: "Happy to help with that!", createdAt: "2026-08-01T10:00:05Z" },
      { id: "m3", role: "user", content: "my email is jane@example.com", createdAt: "2026-08-01T10:00:20Z" },
    ],
    ...overrides,
  };
}

function deflected(
  overrides: Partial<FormattedDeflectedConversation> = {}
): FormattedDeflectedConversation {
  return {
    id: "conv-1",
    title: "I need a refund",
    agent: "portal-a",
    channel: "Widget or Iframe",
    customerMessages: ["I need a refund"],
    turnCount: 1,
    answerConfidence: 0.42,
    createdAt: "2026-08-01T10:00:00Z",
    ...overrides,
  };
}

describe("formatDeflectedConversation", () => {
  it("keeps customer turns and drops assistant turns", () => {
    const sink = new Set<string>();
    const out = formatDeflectedConversation(rawConv(), "portal-a", sink);
    expect(out.customerMessages).toHaveLength(2);
    expect(out.customerMessages.join(" ")).not.toContain("Happy to help");
    expect(out.turnCount).toBe(2);
  });

  it("scrubs PII from customer turns and records the category", () => {
    const sink = new Set<string>();
    const out = formatDeflectedConversation(rawConv(), "portal-a", sink);
    expect(out.customerMessages[1]).toContain("[EMAIL REDACTED]");
    expect(out.customerMessages[1]).not.toContain("jane@example.com");
    expect([...sink]).toContain("email");
  });

  it("never returns country, lead form submissions or user identifiers", () => {
    const sink = new Set<string>();
    const raw = {
      ...rawConv(),
      country: "US",
      form_submission: { name: "Jane Doe", email: "jane@example.com" },
      userId: "user_abc",
    } as ChatbaseConversation;
    const out = formatDeflectedConversation(raw, "portal-a", sink);
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain("US");
    expect(serialized).not.toContain("Jane Doe");
    expect(serialized).not.toContain("user_abc");
    expect(Object.keys(out).sort()).toEqual([
      "agent",
      "answerConfidence",
      "channel",
      "createdAt",
      "customerMessages",
      "id",
      "title",
      "turnCount",
    ]);
  });

  it("uses the first scrubbed customer turn as the title", () => {
    const sink = new Set<string>();
    const out = formatDeflectedConversation(rawConv(), "portal-a", sink);
    expect(out.title).toBe("I need a refund");
  });

  it("normalises a missing confidence score to null rather than NaN", () => {
    const sink = new Set<string>();
    expect(formatDeflectedConversation(rawConv({ min_score: null }), "a", sink).answerConfidence).toBeNull();
    expect(formatDeflectedConversation(rawConv({ min_score: undefined }), "a", sink).answerConfidence).toBeNull();
  });

  it("handles a conversation with no customer turns", () => {
    const sink = new Set<string>();
    const out = formatDeflectedConversation(
      rawConv({ messages: [{ role: "assistant", content: "hello" }] }),
      "a",
      sink
    );
    expect(out.turnCount).toBe(0);
    expect(out.title).toBe("");
  });

  it("handles a conversation with no messages array at all", () => {
    const sink = new Set<string>();
    const out = formatDeflectedConversation(rawConv({ messages: undefined }), "a", sink);
    expect(out.turnCount).toBe(0);
  });
});

describe("analyzeFeedback with deflected signals", () => {
  it("counts deflected conversations toward frequency and reports them separately", () => {
    const result = analyzeFeedback([], [], config, [deflected()]);
    expect(result.deflected_count).toBe(1);
    expect(result.total_data_points).toBe(1);
    const billing = result.themes.find((t) => t.theme_id === "billing");
    expect(billing?.deflected_count).toBe(1);
    expect(billing?.reactive_count).toBe(0);
  });

  it("does not make a theme convergent on deflected signals alone", () => {
    const result = analyzeFeedback([], [], config, [deflected()]);
    const billing = result.themes.find((t) => t.theme_id === "billing");
    expect(billing?.convergent).toBe(false);
    expect(signalTypeOf(billing!)).toBe("deflected");
  });

  it("keeps deflected signals out of severity and vote momentum", () => {
    const result = analyzeFeedback([], [], config, [deflected()]);
    const billing = result.themes.find((t) => t.theme_id === "billing");
    // Severity is reactive-only and momentum proactive-only, so a chat-only
    // theme scores on frequency alone.
    expect(billing?.severity_score).toBe(0);
    expect(billing?.vote_momentum_score).toBe(0);
  });

  it("computes self_serve_failure_rate against the 0.5 threshold", () => {
    const result = analyzeFeedback([], [], config, [
      deflected({ id: "a", answerConfidence: 0.2 }),
      deflected({ id: "b", answerConfidence: 0.4 }),
      deflected({ id: "c", answerConfidence: 0.9 }),
      deflected({ id: "d", answerConfidence: 0.5 }), // 0.5 is not below 0.5
    ]);
    const billing = result.themes.find((t) => t.theme_id === "billing");
    expect(billing?.self_serve_failure_rate).toBe(0.5);
    expect(billing?.mean_answer_confidence).toBe(0.5);
  });

  it("reports null quality when no deflected signal carries a score", () => {
    const result = analyzeFeedback([], [], config, [deflected({ answerConfidence: null })]);
    const billing = result.themes.find((t) => t.theme_id === "billing");
    expect(billing?.self_serve_failure_rate).toBeNull();
    expect(billing?.mean_answer_confidence).toBeNull();
  });

  it("leaves quality null on a theme with no deflected signals", () => {
    const result = analyzeFeedback(
      [
        {
          id: 1,
          number: 1,
          subject: "refund please",
          status: "active",
          createdAt: "2026-08-01T00:00:00Z",
          closedAt: null,
          customerEmail: "[REDACTED]",
          tags: [],
          preview: "refund please",
          customerMessages: ["refund please"],
          threadCount: 1,
        },
      ],
      [],
      config,
      []
    );
    const billing = result.themes.find((t) => t.theme_id === "billing");
    expect(billing?.deflected_count).toBe(0);
    expect(billing?.self_serve_failure_rate).toBeNull();
  });

  it("stays backward compatible when the deflected argument is omitted", () => {
    const result = analyzeFeedback([], [], config);
    expect(result.deflected_count).toBe(0);
  });
});

describe("chatbase_sources aggregation", () => {
  it("counts conversations by source channel", () => {
    const result = analyzeFeedback([], [], config, [
      deflected({ id: "a", channel: "Widget or Iframe" }),
      deflected({ id: "b", channel: "Widget or Iframe" }),
      deflected({ id: "c", channel: "WhatsApp" }),
      deflected({ id: "d", channel: "API" }),
    ]);
    expect(result.chatbase_sources).toEqual({
      "Widget or Iframe": 2,
      WhatsApp: 1,
      API: 1,
    });
  });

  it("reports a single bucket when every conversation shares a source", () => {
    const result = analyzeFeedback([], [], config, [
      deflected({ id: "a" }),
      deflected({ id: "b" }),
      deflected({ id: "c" }),
    ]);
    expect(result.chatbase_sources).toEqual({ "Widget or Iframe": 3 });
  });

  it("omits the field when there is no deflected data", () => {
    const result = analyzeFeedback([], [], config, []);
    expect(result.chatbase_sources).toBeUndefined();
  });

  it("survives trimming at the summary detail level", () => {
    const convs = [
      deflected({ id: "a", channel: "Widget or Iframe" }),
      deflected({ id: "b", channel: "WhatsApp" }),
    ];
    const analysis = analyzeFeedback([], [], config, convs);
    const trimmed = trimAnalysisForDetail(analysis, "summary", [], [], convs) as {
      chatbase_sources?: Record<string, number>;
    };
    expect(trimmed.chatbase_sources).toEqual({ "Widget or Iframe": 1, WhatsApp: 1 });
  });
});

describe("deflected evidence and quotes", () => {
  const theme = (over: Partial<ThemeMatch> = {}): ThemeMatch => ({
    theme_id: "billing",
    label: "Billing",
    category: "billing",
    reactive_count: 0,
    proactive_count: 0,
    deflected_count: 2,
    convergent: false,
    frequency_score: 100,
    severity_score: 0,
    vote_momentum_score: 0,
    priority_score: 35,
    self_serve_failure_rate: 0.5,
    mean_answer_confidence: 0.46,
    data_points: [{ id: "cb-conv-1", source: "DEFLECTED", title: "I need a refund" }],
    ...over,
  });

  it("names chat conversations and the failure rate in the evidence summary", () => {
    const summary = buildEvidenceSummary(theme());
    expect(summary).toContain("2 signals");
    expect(summary).toContain("2 AI chat conversations");
    expect(summary).toContain("50%");
  });

  it("omits the failure sentence when there is no deflected data", () => {
    const summary = buildEvidenceSummary(
      theme({ deflected_count: 0, reactive_count: 1, self_serve_failure_rate: null })
    );
    expect(summary).toContain("1 signals");
    expect(summary).not.toContain("low confidence");
  });

  it("labels a chat quote with its answer confidence", () => {
    const { convMap, reqMap, deflectedMap } = buildLookupMaps([], [], [deflected()]);
    const quotes = extractQuotesForTheme(theme().data_points, convMap, reqMap, 3, deflectedMap);
    expect(quotes[0]).toBe('[AI chat, answer confidence 0.42] "I need a refund"');
  });

  it("omits the confidence label when the score is missing", () => {
    const { convMap, reqMap, deflectedMap } = buildLookupMaps(
      [],
      [],
      [deflected({ answerConfidence: null })]
    );
    const quotes = extractQuotesForTheme(theme().data_points, convMap, reqMap, 3, deflectedMap);
    expect(quotes[0]).toBe('[AI chat] "I need a refund"');
  });

  it("does not apply agent-text heuristics to chat quotes", () => {
    // "happy to help" is agent text in a HelpScout preview, but role=user means
    // the customer actually typed it here.
    const { convMap, reqMap, deflectedMap } = buildLookupMaps(
      [],
      [],
      [deflected({ customerMessages: ["happy to help me find a refund?"] })]
    );
    const quotes = extractQuotesForTheme(theme().data_points, convMap, reqMap, 3, deflectedMap);
    expect(quotes[0]).toContain("happy to help me find a refund?");
  });
});
