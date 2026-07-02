import { describe, it, expect } from "vitest";
import {
  formatConversation,
  formatFeatureRequest,
  trimAnalysisForDetail,
  capTitles,
  signalTypeOf,
  toErrorResult,
} from "./format.js";
import type { Conversation } from "./helpscout.js";
import type { FeatureRequest } from "./productlift.js";
import type { AnalysisResult, ThemeMatch } from "./feedback-analyzer.js";

// ── Fixtures ──

function conv(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: 1,
    number: 101,
    subject: "Billing question",
    status: "active",
    state: "published",
    mailboxId: 10,
    createdAt: "2026-06-01T00:00:00Z",
    closedAt: null,
    tags: [{ id: 1, tag: "bug" }],
    primaryCustomer: { email: "jane@example.com" },
    preview: "Please check my invoice",
    threads: 4,
    ...overrides,
  };
}

function featureRequest(overrides: Partial<FeatureRequest> = {}): FeatureRequest {
  return {
    id: "a",
    title: "CSV export",
    description: "Let me export my data",
    status: { id: 1, name: "open", color: "#fff" },
    category: null,
    votes_count: 12,
    comments_count: 1,
    created_at: "2026-06-01T00:00:00Z",
    updated_at: "2026-06-02T00:00:00Z",
    url: "https://roadmap.acme.com/p/csv-export",
    portal: "acme",
    comments: [
      {
        id: 1,
        comment: "Need this, reach me at jane@example.com",
        author: { id: "u1", name: "Jane Doe", role: "user" },
        pinned_to_top: false,
        tagged_for_changelog: false,
        parent_id: null,
        created_at: "2026-06-01T12:00:00Z",
        updated_at: null,
        url: "https://roadmap.acme.com/p/csv-export#c1",
      },
    ],
    ...overrides,
  };
}

function theme(overrides: Partial<ThemeMatch> = {}): ThemeMatch {
  return {
    theme_id: "billing",
    label: "Billing",
    category: "billing",
    reactive_count: 1,
    proactive_count: 1,
    convergent: true,
    frequency_score: 100,
    severity_score: 50,
    vote_momentum_score: 80,
    priority_score: 150.5,
    data_points: [
      { id: "hs-1", source: "REACTIVE", title: "Billing question" },
      { id: "pl-a", source: "PROACTIVE", title: "CSV export" },
    ],
    ...overrides,
  };
}

function analysis(overrides: Partial<AnalysisResult> = {}): AnalysisResult {
  return {
    config_version: 2,
    known_themes_count: 16,
    total_data_points: 2,
    reactive_count: 1,
    proactive_count: 1,
    themes: [theme()],
    emerging_themes: [
      {
        ngram: "dark mode",
        frequency: 3,
        data_points: [{ id: "hs-9", source: "REACTIVE", title: "dark mode please" }],
      },
    ],
    unmatched_count: 3,
    ...overrides,
  };
}

// ── formatConversation ──

describe("formatConversation", () => {
  it("maps the list API thread count to threadCount, defaulting to 0", () => {
    const sink = new Set<string>();
    expect(formatConversation(conv({ threads: 4 }), sink).threadCount).toBe(4);
    expect(formatConversation(conv({ threads: undefined }), sink).threadCount).toBe(0);
  });

  it("always redacts the customer email field", () => {
    const sink = new Set<string>();
    const formatted = formatConversation(conv(), sink);
    expect(formatted.customerEmail).toBe("[REDACTED]");
  });

  it("scrubs PII from subject and preview and reports categories to the sink", () => {
    const sink = new Set<string>();
    const formatted = formatConversation(
      conv({ preview: "reach me at jane@example.com or 555-123-4567" }),
      sink
    );
    expect(formatted.preview).not.toContain("jane@example.com");
    expect(formatted.customerMessages[0]).not.toContain("jane@example.com");
    expect([...sink].sort()).toEqual(["email", "phone"]);
  });
});

// ── formatFeatureRequest ──

describe("formatFeatureRequest", () => {
  it("drops commenter names, keeping only role, comment, and timestamp", () => {
    const sink = new Set<string>();
    const formatted = formatFeatureRequest(featureRequest(), sink);
    const comment = formatted.comments[0]!;
    expect(Object.keys(comment).sort()).toEqual(["comment", "created_at", "role"]);
    expect(JSON.stringify(formatted)).not.toContain("Jane Doe");
  });

  it("scrubs comment text and reports categories to the sink", () => {
    const sink = new Set<string>();
    const formatted = formatFeatureRequest(featureRequest(), sink);
    expect(formatted.comments[0]!.comment).not.toContain("jane@example.com");
    expect(sink.has("email")).toBe(true);
  });

  it("keeps the source portal label", () => {
    const sink = new Set<string>();
    expect(formatFeatureRequest(featureRequest({ portal: "beta" }), sink).portal).toBe("beta");
  });
});

// ── trimAnalysisForDetail ──

describe("trimAnalysisForDetail", () => {
  const sink = new Set<string>();
  const conversations = [formatConversation(conv(), sink)];
  const featureRequests = [formatFeatureRequest(featureRequest(), sink)];

  it("returns the analysis unchanged at full detail", () => {
    const a = analysis();
    expect(trimAnalysisForDetail(a, "full", conversations, featureRequests)).toBe(a);
  });

  it("omits sub-scores and titles at summary detail", () => {
    const result = trimAnalysisForDetail(
      analysis(),
      "summary",
      conversations,
      featureRequests
    ) as { themes: Array<Record<string, unknown>>; emerging_themes: Array<Record<string, unknown>> };

    const t = result.themes[0]!;
    expect(t.signal_type).toBe("convergent");
    expect(t.evidence_summary).toContain("2 signals");
    expect(t.representative_quotes).toBeDefined();
    expect(t.frequency_score).toBeUndefined();
    expect(t.data_point_titles).toBeUndefined();
    expect(result.emerging_themes[0]!.sample_titles).toBeUndefined();
  });

  it("adds sub-scores and capped titles at standard detail", () => {
    const result = trimAnalysisForDetail(
      analysis(),
      "standard",
      conversations,
      featureRequests
    ) as { themes: Array<Record<string, unknown>> };

    const t = result.themes[0]!;
    expect(t.frequency_score).toBe(100);
    expect(t.data_points_total).toBe(2);
    expect(t.data_point_titles).toEqual(["Billing question", "CSV export"]);
    expect(t.data_point_titles_truncated).toBeUndefined();
  });

  it("produces single-line quotes even when messages contain newlines", () => {
    const sink2 = new Set<string>();
    const multiline = [
      formatConversation(conv({ preview: "line one\nline two about billing" }), sink2),
    ];
    const result = trimAnalysisForDetail(
      analysis(),
      "summary",
      multiline,
      featureRequests
    ) as { themes: Array<{ representative_quotes: string[] }> };
    for (const q of result.themes[0]!.representative_quotes) {
      expect(q).not.toContain("\n");
    }
  });
});

// ── helpers ──

describe("capTitles", () => {
  it("caps titles at 50 and sets the truncation flag", () => {
    const dataPoints = Array.from({ length: 60 }, (_, i) => ({
      id: `hs-${i}`,
      source: "REACTIVE" as const,
      title: `title ${i}`,
    }));
    const capped = capTitles(dataPoints);
    expect(capped.data_points_total).toBe(60);
    expect(capped.data_point_titles).toHaveLength(50);
    expect(capped.data_point_titles_truncated).toBe(true);
  });

  it("omits the truncation flag when under the cap", () => {
    const capped = capTitles([{ id: "hs-1", source: "REACTIVE", title: "one" }]);
    expect(capped.data_points_total).toBe(1);
    expect("data_point_titles_truncated" in capped).toBe(false);
  });
});

describe("signalTypeOf", () => {
  it("classifies convergent, reactive, and proactive themes", () => {
    expect(signalTypeOf(theme({ convergent: true }))).toBe("convergent");
    expect(signalTypeOf(theme({ convergent: false, reactive_count: 2, proactive_count: 0 }))).toBe("reactive");
    expect(signalTypeOf(theme({ convergent: false, reactive_count: 0, proactive_count: 2 }))).toBe("proactive");
  });
});

describe("toErrorResult", () => {
  it("wraps an Error message and flags isError", () => {
    const result = toErrorResult(new Error("boom"));
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toBe("Error: boom");
  });

  it("falls back to a generic message for non-Error values", () => {
    expect(toErrorResult("weird").content[0]!.text).toBe("Error: Unknown error");
  });
});
