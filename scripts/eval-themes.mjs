#!/usr/bin/env node
// Theme-matching eval runner — answers "is theme assignment actually correct?"
//
// Usage (build first so dist/ exists):
//   npm run build && npm run eval
//   npm run eval -- --failures                 # show every miss and false positive
//   npm run eval -- --json                     # machine-readable report
//   npm run eval -- --min-f1 0.60              # non-zero exit below threshold (CI gate)
//   npm run eval -- --fixture ./local/real.jsonl
//
// The committed fixture (evals/theme-matching.jsonl) is hand-labelled synthetic
// text: it is a REGRESSION GATE, not evidence about your production data. For a
// real number, export your own signals to a local gitignored .jsonl in the same
// shape and pass --fixture. Real fixtures contain customer text — never commit one.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : (args[i + 1] ?? true);
};
const AS_JSON = args.includes("--json");
const SHOW_FAILURES = args.includes("--failures");
const MIN_F1 = flag("--min-f1", null);
const FIXTURE = resolve(root, String(flag("--fixture", "evals/theme-matching.jsonl")));

const { evaluate, confusionPairs } = await import(resolve(root, "dist", "theme-eval.js"));
const { loadThemesConfig } = await import(resolve(root, "dist", "feedback-analyzer.js"));

// ── Load fixture ──
let examples;
try {
  examples = readFileSync(FIXTURE, "utf-8")
    .split("\n")
    .map((line, i) => ({ line: line.trim(), i }))
    .filter(({ line }) => line.length > 0 && !line.startsWith("//"))
    .map(({ line, i }) => {
      try {
        return JSON.parse(line);
      } catch (e) {
        throw new Error(`${FIXTURE}:${i + 1} is not valid JSON — ${e.message}`);
      }
    });
} catch (e) {
  console.error(`Failed to read fixture: ${e.message}`);
  process.exit(1);
}

const config = loadThemesConfig();
const report = evaluate(examples, config);

if (AS_JSON) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const pct = (n) => `${(n * 100).toFixed(1)}%`;
  const bar = "─".repeat(72);

  console.log(`\nTheme-matching eval — themes.config.json v${report.config_version}`);
  console.log(`fixture: ${FIXTURE.replace(root + "/", "")}  (${report.total_examples} examples)`);
  if (FIXTURE.endsWith("evals/theme-matching.jsonl")) {
    console.log("note:    synthetic regression fixture — not a claim about production data");
  }

  console.log(`\n${bar}\nOVERALL\n${bar}`);
  console.log(`  micro  P ${pct(report.micro.precision)}   R ${pct(report.micro.recall)}   F1 ${pct(report.micro.f1)}`);
  console.log(`  macro  P ${pct(report.macro.precision)}   R ${pct(report.macro.recall)}   F1 ${pct(report.macro.f1)}`);
  console.log(`  miss rate        ${pct(report.miss_rate)}  (expected a theme, matched nothing)`);
  console.log(`  false alarm rate ${pct(report.false_alarm_rate)}  (expected nothing, matched something)`);

  console.log(`\n${bar}\nBY REGISTER — does keyword tuning transfer across sources?\n${bar}`);
  console.log(`  ${"register".padEnd(10)} ${"n".padStart(4)}  ${"P".padStart(7)} ${"R".padStart(7)} ${"F1".padStart(7)}  miss`);
  for (const r of report.per_register) {
    console.log(
      `  ${r.register.padEnd(10)} ${String(r.examples).padStart(4)}  ` +
        `${pct(r.precision).padStart(7)} ${pct(r.recall).padStart(7)} ${pct(r.f1).padStart(7)}  ${pct(r.miss_rate)}`
    );
  }

  console.log(`\n${bar}\nBY THEME (support > 0, worst F1 first)\n${bar}`);
  console.log(`  ${"theme".padEnd(22)} ${"sup".padStart(4)} ${"tp".padStart(3)} ${"fp".padStart(3)} ${"fn".padStart(3)}  ${"P".padStart(7)} ${"R".padStart(7)} ${"F1".padStart(7)}`);
  const supported = report.per_theme.filter((t) => t.support > 0).sort((a, b) => a.f1 - b.f1);
  for (const t of supported) {
    console.log(
      `  ${t.theme_id.padEnd(22)} ${String(t.support).padStart(4)} ${String(t.tp).padStart(3)} ` +
        `${String(t.fp).padStart(3)} ${String(t.fn).padStart(3)}  ` +
        `${pct(t.precision).padStart(7)} ${pct(t.recall).padStart(7)} ${pct(t.f1).padStart(7)}`
    );
  }
  const unexercised = report.per_theme.filter((t) => t.support === 0);
  if (unexercised.length > 0) {
    console.log(`\n  not exercised by this fixture: ${unexercised.map((t) => t.theme_id).join(", ")}`);
  }

  const collisions = confusionPairs(report);
  if (collisions.length > 0) {
    console.log(`\n${bar}\nKEYWORD COLLISIONS (theme B fires on theme A's examples, ≥2×)\n${bar}`);
    for (const c of collisions) {
      console.log(`  ${c.expected.padEnd(22)} → also matched ${c.spurious.padEnd(22)} ${c.count}×`);
    }
  }

  if (SHOW_FAILURES) {
    const misses = report.results.filter((r) => r.missed.length > 0);
    const spurious = report.results.filter((r) => r.spurious.length > 0);
    console.log(`\n${bar}\nMISSES (${misses.length})\n${bar}`);
    for (const r of misses) {
      console.log(`  [${r.register}] "${r.text}"`);
      console.log(`      missed: ${r.missed.join(", ")}`);
    }
    console.log(`\n${bar}\nFALSE POSITIVES (${spurious.length})\n${bar}`);
    for (const r of spurious) {
      console.log(`  [${r.register}] "${r.text}"`);
      console.log(`      spurious: ${r.spurious.join(", ")}`);
    }
  } else {
    console.log("\nRun with --failures to see every miss and false positive.");
  }
  console.log("");
}

if (MIN_F1 !== null) {
  const threshold = Number(MIN_F1);
  if (!Number.isFinite(threshold)) {
    console.error(`--min-f1 expects a number, got: ${MIN_F1}`);
    process.exit(2);
  }
  if (report.micro.f1 < threshold) {
    console.error(
      `FAIL: micro F1 ${report.micro.f1.toFixed(3)} is below --min-f1 ${threshold.toFixed(3)}`
    );
    process.exit(1);
  }
  console.error(`PASS: micro F1 ${report.micro.f1.toFixed(3)} ≥ ${threshold.toFixed(3)}`);
}
