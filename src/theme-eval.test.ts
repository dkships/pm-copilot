import { describe, it, expect } from "vitest";
import { evaluate, predictThemes, confusionPairs } from "./theme-eval.js";
import type { EvalExample } from "./theme-eval.js";
import type { ThemesConfig } from "./feedback-analyzer.js";

const config: ThemesConfig = {
  version: 99,
  themes: [
    { id: "billing", label: "Billing", keywords: ["refund", "invoice"], category: "billing" },
    { id: "auth", label: "Auth", keywords: ["password", "sign in"], category: "auth" },
    { id: "perf", label: "Perf", keywords: ["slow"], category: "reliability" },
  ],
  stop_words: [],
  emerging_theme_min_frequency: 3,
};

const ex = (over: Partial<EvalExample> & { text: string }): EvalExample => ({
  id: over.id ?? "x",
  register: over.register ?? "ticket",
  source: over.source ?? "REACTIVE",
  text: over.text,
  expected_themes: over.expected_themes ?? [],
});

describe("predictThemes", () => {
  it("returns every theme whose keywords match", () => {
    expect(predictThemes("refund is slow", config).sort()).toEqual(["billing", "perf"]);
  });

  it("lowercases before matching, like analyzeFeedback does", () => {
    expect(predictThemes("REFUND PLEASE", config)).toEqual(["billing"]);
  });

  it("returns empty when nothing matches", () => {
    expect(predictThemes("hello there", config)).toEqual([]);
  });
});

describe("evaluate", () => {
  it("scores a perfect fixture at 100%", () => {
    const report = evaluate(
      [
        ex({ id: "a", text: "need a refund", expected_themes: ["billing"] }),
        ex({ id: "b", text: "forgot password", expected_themes: ["auth"] }),
      ],
      config
    );
    expect(report.micro.precision).toBe(1);
    expect(report.micro.recall).toBe(1);
    expect(report.micro.f1).toBe(1);
    expect(report.miss_rate).toBe(0);
  });

  it("counts a miss as a false negative and raises miss_rate", () => {
    const report = evaluate(
      [ex({ id: "a", text: "money back please", expected_themes: ["billing"] })],
      config
    );
    const billing = report.per_theme.find((t) => t.theme_id === "billing");
    expect(billing?.fn).toBe(1);
    expect(billing?.tp).toBe(0);
    expect(billing?.recall).toBe(0);
    expect(report.miss_rate).toBe(1);
  });

  it("counts an unexpected match as a false positive without touching miss_rate", () => {
    const report = evaluate(
      [ex({ id: "a", text: "refund", expected_themes: ["auth"] })],
      config
    );
    expect(report.per_theme.find((t) => t.theme_id === "billing")?.fp).toBe(1);
    expect(report.per_theme.find((t) => t.theme_id === "auth")?.fn).toBe(1);
    // miss_rate tracks signals that fell through entirely. This one was
    // mislabelled, not dropped — recall catches that, miss_rate should not.
    expect(report.miss_rate).toBe(0);
  });

  it("counts a wholly unmatched example as a miss even when other examples match", () => {
    const report = evaluate(
      [
        ex({ id: "a", text: "need a refund", expected_themes: ["billing"] }),
        ex({ id: "b", text: "money back please", expected_themes: ["billing"] }),
      ],
      config
    );
    expect(report.miss_rate).toBe(0.5);
  });

  it("tracks false alarms separately from misses", () => {
    const report = evaluate(
      [
        ex({ id: "a", text: "this is slow", expected_themes: [] }),
        ex({ id: "b", text: "nothing relevant", expected_themes: [] }),
      ],
      config
    );
    expect(report.false_alarm_rate).toBe(0.5);
    expect(report.miss_rate).toBe(0); // nothing was expected, so nothing can be missed
  });

  it("credits multi-label examples per label", () => {
    const report = evaluate(
      [ex({ id: "a", text: "refund page is slow", expected_themes: ["billing", "perf"] })],
      config
    );
    expect(report.micro.recall).toBe(1);
    expect(report.per_theme.find((t) => t.theme_id === "billing")?.tp).toBe(1);
    expect(report.per_theme.find((t) => t.theme_id === "perf")?.tp).toBe(1);
  });

  it("excludes zero-support themes from the macro average", () => {
    const report = evaluate(
      [ex({ id: "a", text: "need a refund", expected_themes: ["billing"] })],
      config
    );
    // Only `billing` has support; auth and perf must not average in as free 1.0s.
    expect(report.macro.f1).toBe(1);
    expect(report.per_theme.find((t) => t.theme_id === "auth")?.support).toBe(0);
  });

  it("breaks metrics down per register", () => {
    const report = evaluate(
      [
        ex({ id: "a", register: "ticket", text: "need a refund", expected_themes: ["billing"] }),
        ex({ id: "b", register: "chat", text: "money back", expected_themes: ["billing"] }),
      ],
      config
    );
    const ticket = report.per_register.find((r) => r.register === "ticket");
    const chat = report.per_register.find((r) => r.register === "chat");
    expect(ticket?.recall).toBe(1);
    expect(chat?.recall).toBe(0);
    expect(chat?.miss_rate).toBe(1);
  });

  it("throws on a fixture that references an unknown theme id", () => {
    expect(() =>
      evaluate([ex({ id: "a", text: "whatever", expected_themes: ["nope"] })], config)
    ).toThrow(/absent from themes.config.json/);
  });

  it("handles an empty fixture without dividing by zero", () => {
    const report = evaluate([], config);
    expect(report.total_examples).toBe(0);
    expect(report.miss_rate).toBe(0);
    expect(report.false_alarm_rate).toBe(0);
    expect(Number.isFinite(report.micro.f1)).toBe(true);
  });
});

describe("confusionPairs", () => {
  it("reports themes that repeatedly fire on another theme's examples", () => {
    const report = evaluate(
      [
        ex({ id: "a", text: "refund", expected_themes: ["auth"] }),
        ex({ id: "b", text: "refund", expected_themes: ["auth"] }),
      ],
      config
    );
    expect(confusionPairs(report)).toEqual([
      { expected: "auth", spurious: "billing", count: 2 },
    ]);
  });

  it("suppresses one-off collisions below the threshold", () => {
    const report = evaluate(
      [ex({ id: "a", text: "refund", expected_themes: ["auth"] })],
      config
    );
    expect(confusionPairs(report)).toEqual([]);
  });
});
