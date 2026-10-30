#!/usr/bin/env node
// Check the demo theme config against the demo tickets, through the same
// loader, PII scrubber and analyzer the server uses (build first).
//
// Usage:
//   npm run build && node demo/scripts/check-coverage.mjs [--errors] [--json]
//
// Each ticket carries a ground-truth label (syntheticTheme). 44 also carry
// syntheticSecondaryTheme; on reading, 19 of those genuinely raise the second
// problem (CONFIRMED_MULTI) and the rest only mention it in passing. Reports:
//   - coverage: share of tickets matching at least one theme (target >= 90%)
//   - per-theme precision and recall against those labels (target >= 85%)
//   - a confusion table of label vs. matched theme
//   - a "human check": a seeded sample of 20 tickets, stratified by
//     pm-copilot's best-matching theme, comparing that theme with the label,
//     which stands in for a reviewer
//   - how many emails and phone numbers the scrubber redacted
// --errors lists every false positive and miss; --json prints the numbers.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..", "..");
const TICKETS = resolve(root, "demo", "tickets.healthcare-dispatch.json");
const THEMES = resolve(root, "demo", "themes.healthcare-dispatch.json");
const SHOW_ERRORS = process.argv.includes("--errors");
const AS_JSON = process.argv.includes("--json");
const COVERAGE_TARGET = 0.9;
const PRECISION_TARGET = 0.85;
const SAMPLE_SIZE = 20;
const SAMPLE_SEED = 20; // fixed so the 20 shown on screen don't change between runs

// Theme id in the demo config for each label key in the fixture.
const THEME_ID = {
  calendar: "calendar-reliability",
  double_booking: "double-booking",
  reassignment: "driver-reassignment",
  driver_app: "driver-app-sync",
  notifications: "facility-notifications",
  reporting: "reporting-billing",
  permissions: "user-access",
  automation: "dispatch-automation",
};
// Tickets whose secondary label holds up on reading the text: the customer
// asks for both problems to be fixed. A match on either theme is correct.
// Ids are stable across build-tickets.mjs reruns.
const CONFIRMED_MULTI = new Set([
  4100010, 4100013, 4100019, 4100040, 4100053, 4100064, 4100073, 4100080, 4100083,
  4100086, 4100087, 4100096, 4100102, 4100107, 4100125, 4100128, 4100140, 4100170,
  4100193,
].map((id) => `hs-${id}`));

const KEY_OF = Object.fromEntries(Object.entries(THEME_ID).map(([k, id]) => [id, k]));

const { FixtureTicketSource } = await import(resolve(root, "dist", "fixture-tickets.js"));
const { formatConversation } = await import(resolve(root, "dist", "format.js"));
const { analyzeFeedback, matchesTheme } = await import(resolve(root, "dist", "feedback-analyzer.js"));

// ── Run the real pipeline ──

const raw = JSON.parse(readFileSync(TICKETS, "utf-8")).conversations;
const labels = new Map(
  raw.map((c) => {
    const id = `hs-${c.id}`;
    const secondary = CONFIRMED_MULTI.has(id) ? c.syntheticSecondaryTheme : null;
    return [id, { primary: c.syntheticTheme, secondary, labelledSecondary: c.syntheticSecondaryTheme ?? null }];
  })
);

const conversations = await new FixtureTicketSource(TICKETS).fetchConversations({ timeframeDays: 30 });
const pii = new Set();
const formatted = conversations.map((c) => formatConversation(c, pii));
const byId = new Map(formatted.map((c) => [`hs-${c.id}`, c]));
const config = JSON.parse(readFileSync(THEMES, "utf-8"));
const analysis = analyzeFeedback(formatted, [], config);

// Matched theme keys per ticket.
const matched = new Map(formatted.map((c) => [`hs-${c.id}`, new Set()]));
for (const theme of analysis.themes) {
  for (const dp of theme.data_points) {
    matched.get(dp.id)?.add(KEY_OF[theme.theme_id]);
  }
}

const ids = [...matched.keys()];
const total = ids.length;
const covered = ids.filter((id) => matched.get(id).size > 0).length;
const coverage = covered / total;

// ── Precision and recall ──
// A match is correct when the theme is the ticket's primary label, or its
// confirmed secondary label. Strict precision credits the primary only.

const pct = (n, d) => (d === 0 ? null : n / d);
const fmt = (x) => (x === null ? "  n/a" : `${(x * 100).toFixed(0).padStart(4)}%`);

const perTheme = Object.keys(THEME_ID).map((key) => {
  const hits = ids.filter((id) => matched.get(id).has(key));
  const correct = hits.filter((id) => [labels.get(id).primary, labels.get(id).secondary].includes(key));
  const strict = hits.filter((id) => labels.get(id).primary === key);
  const labelled = ids.filter((id) => labels.get(id).primary === key);
  const found = labelled.filter((id) => matched.get(id).has(key));
  return {
    theme: THEME_ID[key],
    key,
    matched: hits.length,
    precision: pct(correct.length, hits.length),
    strict_precision: pct(strict.length, hits.length),
    recall: pct(found.length, labelled.length),
    labelled: labelled.length,
    false_positives: hits.filter((id) => !correct.includes(id)),
    misses: labelled.filter((id) => !found.includes(id)),
  };
});

const multiLabelled = ids.filter((id) => labels.get(id).labelledSecondary).length;
const multiConfirmed = ids.filter((id) => labels.get(id).secondary).length;
const multiMatched = ids.filter((id) => matched.get(id).size > 1).length;

// ── Confusion table: label (rows) vs. matched theme (columns) ──

const keys = Object.keys(THEME_ID);
const confusion = Object.fromEntries(
  keys.map((row) => [
    row,
    Object.fromEntries([...keys, "none"].map((col) => [col, 0])),
  ])
);
for (const id of ids) {
  const row = confusion[labels.get(id).primary];
  const themes = matched.get(id);
  if (themes.size === 0) {
    row.none++;
    continue;
  }
  for (const col of themes) row[col]++;
}

// ── Human check: seeded, stratified sample of 20 ──
// pm-copilot assigns every theme whose keywords match. Its "best" theme for a
// ticket is the one with the most distinct keyword hits; ties go to the
// higher-priority theme. The sample is stratified by that best theme, in
// proportion to its share of tickets (at least one each), the way a reviewer
// spot-checks every AI-proposed category. An unstratified draw can land mostly
// in the biggest category: seed 20 drew 14 calendar tickets out of 20.

function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const priorityRank = new Map(analysis.themes.map((t, i) => [KEY_OF[t.theme_id], i]));
const keywordsOf = new Map(config.themes.map((t) => [KEY_OF[t.id], t.keywords]));

function bestTheme(id) {
  const c = byId.get(id);
  const text = [c.subject, c.preview, ...c.customerMessages].join(" ").toLowerCase();
  const scored = [...matched.get(id)].map((key) => ({
    key,
    hits: keywordsOf.get(key).filter((kw) => matchesTheme(text, [kw])).length,
  }));
  scored.sort((a, b) => b.hits - a.hits || priorityRank.get(a.key) - priorityRank.get(b.key));
  return scored[0]?.key ?? "none";
}

const best = new Map(ids.map((id) => [id, bestTheme(id)]));
const strata = new Map();
for (const id of [...ids].sort()) {
  const key = best.get(id);
  if (key === "none") {
    continue;
  }
  strata.set(key, [...(strata.get(key) ?? []), id]);
}

// Largest-remainder allocation of SAMPLE_SIZE across strata, minimum one each.
const classified = [...strata.values()].reduce((n, s) => n + s.length, 0);
const alloc = [...strata].map(([key, members]) => {
  const exact = (members.length / classified) * (SAMPLE_SIZE - strata.size);
  return { key, members, n: 1 + Math.floor(exact), rem: exact % 1 };
});
let left = SAMPLE_SIZE - alloc.reduce((n, a) => n + a.n, 0);
for (const a of [...alloc].sort((x, y) => y.rem - x.rem)) {
  if (left-- <= 0) {
    break;
  }
  a.n++;
}

// Seeded shuffle within each stratum; ids are stable across reruns.
const rand = prng(SAMPLE_SEED);
const sample = alloc.flatMap(({ members, n }) => {
  const pool = [...members];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, n).map((id) => ({
    id,
    subject: byId.get(id).subject,
    pm_copilot: best.get(id),
    reviewer: labels.get(id).primary,
  }));
});
const agreed = sample.filter((s) => s.pm_copilot === s.reviewer).length;

// ── Redaction counts ──
// The scrubber reports categories, not counts, so count its placeholders.

const countOf = (re) =>
  formatted.reduce((n, c) => n + (`${c.subject} ${c.preview}`.match(re) ?? []).length, 0);
const ticketsWith = (re) => formatted.filter((c) => re.test(`${c.subject} ${c.preview}`)).length;
const redaction = {
  emails: countOf(/\[EMAIL REDACTED\]/g),
  phones: countOf(/\[PHONE REDACTED\]/g),
  tickets: ticketsWith(/\[(EMAIL|PHONE) REDACTED\]/),
};

const precisionPass = perTheme.every((t) => t.precision === null || t.precision >= PRECISION_TARGET);
const coveragePass = coverage >= COVERAGE_TARGET;
process.exitCode = precisionPass && coveragePass ? 0 : 1;

if (AS_JSON) {
  console.log(
    JSON.stringify(
      {
        total,
        coverage,
        multi_labelled: multiLabelled,
        multi_confirmed: multiConfirmed,
        multi_matched: multiMatched,
        themes: perTheme.map(({ false_positives, misses, ...t }) => t),
        confusion,
        human_check: { agreed, size: SAMPLE_SIZE, sample },
        redaction,
      },
      null,
      2
    )
  );
  process.exit();
}

// ── Report ──

const subjectOf = (id) => byId.get(id)?.subject ?? id;
const pass = (ok) => (ok ? "PASS" : "FAIL");

console.log(`Tickets in 30-day window: ${total} (file has ${raw.length})`);
console.log(
  `Coverage: ${covered}/${total} = ${(coverage * 100).toFixed(1)}% ` +
    `(target ${COVERAGE_TARGET * 100}%) ${pass(coveragePass)}`
);
console.log(
  `Multi-theme: ${multiLabelled} tickets carry a second label; ${multiConfirmed} genuinely raise ` +
    `both problems on reading; ${multiMatched} match more than one theme`
);

console.log(`\nPer theme (precision target ${PRECISION_TARGET * 100}%) ${pass(precisionPass)}`);
console.log("theme                     matched  precision  strict  recall");
for (const t of perTheme) {
  console.log(
    `${t.theme.padEnd(26)}${String(t.matched).padStart(7)}  ${fmt(t.precision).padStart(9)}  ` +
      `${fmt(t.strict_precision)}  ${fmt(t.recall)} (${t.labelled - t.misses.length}/${t.labelled})`
  );
}
console.log("precision credits the primary label or a confirmed second problem; strict credits the primary only");

const short = { calendar: "cal", double_booking: "dbl", reassignment: "rea", driver_app: "app",
  notifications: "ntf", reporting: "rpt", permissions: "acc", automation: "aut", none: "none" };
console.log("\nConfusion: label (rows) vs. matched theme (columns); a ticket can match several");
console.log("label".padEnd(15) + [...keys, "none"].map((k) => short[k].padStart(5)).join(""));
for (const row of keys) {
  console.log(row.padEnd(15) + [...keys, "none"].map((col) => String(confusion[row][col]).padStart(5)).join(""));
}

console.log(`\nHuman check: ${SAMPLE_SIZE} tickets, seed ${SAMPLE_SEED}, stratified by pm-copilot's best theme`);
console.log("best theme = most distinct keyword hits (ties: higher priority); reviewer = syntheticTheme label");
for (const s of sample) {
  const mark = s.pm_copilot === s.reviewer ? "agree   " : "DISAGREE";
  console.log(`  ${mark} pm-copilot: ${s.pm_copilot.padEnd(15)} reviewer: ${s.reviewer.padEnd(15)} ${s.subject}`);
}
console.log(`Agreement: ${agreed}/${SAMPLE_SIZE} (${((agreed / SAMPLE_SIZE) * 100).toFixed(0)}%)`);

console.log(
  `\nPII redacted: ${redaction.emails} emails, ${redaction.phones} phones in ${redaction.tickets} tickets; ` +
    `categories: ${[...pii].join(", ") || "none"}`
);

if (SHOW_ERRORS) {
  for (const t of perTheme) {
    console.log(`\n== ${t.theme}`);
    for (const id of t.false_positives) {
      const l = labels.get(id);
      const second = l.labelledSecondary ? `+${l.labelledSecondary}${l.secondary ? "" : "?"}` : "";
      console.log(`  FP  [${l.primary}${second}] ${subjectOf(id)}`);
    }
    for (const id of t.misses) {
      console.log(`  MISS ${subjectOf(id)} | ${byId.get(id).preview.replace(/\s+/g, " ").slice(0, 150)}`);
    }
  }
}
