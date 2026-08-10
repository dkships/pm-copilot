/**
 * Theme-matching evaluation — measures whether theme assignment is actually
 * correct, rather than only that the scoring mechanics behave.
 *
 * Theme matching is multi-label: one signal can legitimately belong to several
 * themes (a "double booking after calendar sync" ticket is both), so metrics are
 * computed per theme over (expected, predicted) label sets, then averaged.
 *
 * Pure functions only — no I/O. The runner in scripts/eval-themes.mjs loads
 * fixtures and formats output.
 */

import { matchesTheme, type ThemesConfig, type SignalType } from "./feedback-analyzer.js";

// ── Types ──

export type Register = "ticket" | "roadmap" | "chat";

export interface EvalExample {
  id: string;
  /** Which source's language this is phrased in. Keywords tuned on one register
   *  do not necessarily transfer to another — that is the thing being measured. */
  register: Register;
  source: SignalType;
  text: string;
  /** Theme ids a PM would want this matched to. Empty = should match nothing. */
  expected_themes: string[];
}

export interface Metrics {
  precision: number;
  recall: number;
  f1: number;
}

export interface ThemeMetrics extends Metrics {
  theme_id: string;
  tp: number;
  fp: number;
  fn: number;
  /** Number of examples whose expected set contains this theme. */
  support: number;
}

export interface RegisterMetrics extends Metrics {
  register: Register;
  examples: number;
  /** Share of examples that expected ≥1 theme but matched none. */
  miss_rate: number;
}

export interface ExampleResult {
  id: string;
  register: Register;
  text: string;
  expected: string[];
  predicted: string[];
  missed: string[];
  spurious: string[];
}

export interface EvalReport {
  config_version: number;
  total_examples: number;
  /** Aggregate over all label decisions — dominated by high-support themes. */
  micro: Metrics;
  /** Unweighted mean over themes with support > 0 — surfaces weak rare themes. */
  macro: Metrics;
  per_theme: ThemeMetrics[];
  per_register: RegisterMetrics[];
  /** Examples expecting ≥1 theme that matched none. The blind-spot number. */
  miss_rate: number;
  /** Examples expecting nothing that matched something. */
  false_alarm_rate: number;
  results: ExampleResult[];
}

// ── Prediction ──

/** Apply the live matcher exactly as analyzeFeedback does, on the same lowercased text. */
export function predictThemes(text: string, config: ThemesConfig): string[] {
  const lowered = text.toLowerCase();
  return config.themes
    .filter((theme) => matchesTheme(lowered, theme.keywords))
    .map((theme) => theme.id);
}

// ── Metric helpers ──

/**
 * Precision/recall with the degenerate cases pinned down: when there is nothing
 * to find and nothing was found, that is a correct decision (1.0), not 0/0.
 */
function ratio(numerator: number, denominator: number, vacuous: boolean): number {
  if (denominator === 0) return vacuous ? 1 : 0;
  return numerator / denominator;
}

function f1From(precision: number, recall: number): number {
  if (precision + recall === 0) return 0;
  return (2 * precision * recall) / (precision + recall);
}

function metricsFrom(tp: number, fp: number, fn: number): Metrics {
  const precision = ratio(tp, tp + fp, fn === 0);
  const recall = ratio(tp, tp + fn, fp === 0);
  return { precision, recall, f1: f1From(precision, recall) };
}

// ── Main evaluation ──

export function evaluate(examples: EvalExample[], config: ThemesConfig): EvalReport {
  const knownThemeIds = new Set(config.themes.map((t) => t.id));

  const unknown = new Set<string>();
  for (const ex of examples) {
    for (const id of ex.expected_themes) {
      if (!knownThemeIds.has(id)) unknown.add(id);
    }
  }
  if (unknown.size > 0) {
    throw new Error(
      `Eval fixture references theme ids absent from themes.config.json: ${[...unknown].join(", ")}. ` +
        "Fix the fixture or the config — a silent mismatch would report false misses."
    );
  }

  const counts = new Map<string, { tp: number; fp: number; fn: number; support: number }>();
  for (const id of knownThemeIds) counts.set(id, { tp: 0, fp: 0, fn: 0, support: 0 });

  const results: ExampleResult[] = [];
  let missed = 0;
  let expectingSomething = 0;
  let falseAlarms = 0;
  let expectingNothing = 0;

  for (const ex of examples) {
    const predicted = predictThemes(ex.text, config);
    const expectedSet = new Set(ex.expected_themes);
    const predictedSet = new Set(predicted);

    for (const id of expectedSet) {
      const c = counts.get(id)!;
      c.support += 1;
      if (predictedSet.has(id)) c.tp += 1;
      else c.fn += 1;
    }
    for (const id of predictedSet) {
      if (!expectedSet.has(id)) counts.get(id)!.fp += 1;
    }

    if (expectedSet.size > 0) {
      expectingSomething += 1;
      if (predictedSet.size === 0) missed += 1;
    } else {
      expectingNothing += 1;
      if (predictedSet.size > 0) falseAlarms += 1;
    }

    results.push({
      id: ex.id,
      register: ex.register,
      text: ex.text,
      expected: [...expectedSet],
      predicted,
      missed: [...expectedSet].filter((id) => !predictedSet.has(id)),
      spurious: predicted.filter((id) => !expectedSet.has(id)),
    });
  }

  // Per-theme, ordered by support then id so output is stable across runs.
  const per_theme: ThemeMetrics[] = [...counts.entries()]
    .map(([theme_id, c]) => ({
      theme_id,
      ...c,
      ...metricsFrom(c.tp, c.fp, c.fn),
    }))
    .sort((a, b) => b.support - a.support || a.theme_id.localeCompare(b.theme_id));

  // Micro: pool every label decision.
  const totals = per_theme.reduce(
    (acc, t) => ({ tp: acc.tp + t.tp, fp: acc.fp + t.fp, fn: acc.fn + t.fn }),
    { tp: 0, fp: 0, fn: 0 }
  );
  const micro = metricsFrom(totals.tp, totals.fp, totals.fn);

  // Macro: mean over themes the fixture actually exercises. Themes with no
  // support are excluded — including them would average in meaningless 1.0s.
  const supported = per_theme.filter((t) => t.support > 0);
  const mean = (pick: (t: ThemeMetrics) => number): number =>
    supported.length === 0
      ? 0
      : supported.reduce((sum, t) => sum + pick(t), 0) / supported.length;
  const macro: Metrics = {
    precision: mean((t) => t.precision),
    recall: mean((t) => t.recall),
    f1: mean((t) => t.f1),
  };

  // Per register — the transfer question: do ticket-tuned keywords hold up on chat?
  const registers = [...new Set(examples.map((e) => e.register))].sort();
  const per_register: RegisterMetrics[] = registers.map((register) => {
    const subset = results.filter((r) => r.register === register);
    let tp = 0;
    let fp = 0;
    let fn = 0;
    let subMissed = 0;
    let subExpecting = 0;
    for (const r of subset) {
      const expected = new Set(r.expected);
      const predicted = new Set(r.predicted);
      for (const id of expected) (predicted.has(id) ? tp++ : fn++);
      for (const id of predicted) if (!expected.has(id)) fp++;
      if (expected.size > 0) {
        subExpecting += 1;
        if (predicted.size === 0) subMissed += 1;
      }
    }
    return {
      register,
      examples: subset.length,
      ...metricsFrom(tp, fp, fn),
      miss_rate: subExpecting === 0 ? 0 : subMissed / subExpecting,
    };
  });

  return {
    config_version: config.version,
    total_examples: examples.length,
    micro,
    macro,
    per_theme,
    per_register,
    miss_rate: expectingSomething === 0 ? 0 : missed / expectingSomething,
    false_alarm_rate: expectingNothing === 0 ? 0 : falseAlarms / expectingNothing,
    results,
  };
}

/** Themes whose keywords fire on each other's examples — the collision report. */
export function confusionPairs(
  report: EvalReport,
  minCount = 2
): Array<{ expected: string; spurious: string; count: number }> {
  const pairs = new Map<string, number>();
  for (const r of report.results) {
    for (const expected of r.expected) {
      for (const spurious of r.spurious) {
        const key = `${expected} ${spurious}`;
        pairs.set(key, (pairs.get(key) ?? 0) + 1);
      }
    }
  }
  return [...pairs.entries()]
    .filter(([, count]) => count >= minCount)
    .map(([key, count]) => {
      const [expected, spurious] = key.split(" ");
      return { expected: expected!, spurious: spurious!, count };
    })
    .sort((a, b) => b.count - a.count);
}
