#!/usr/bin/env node
// Check the demo theme config against the demo tickets, through the same
// loader, PII scrubber and analyzer the server uses (build first).
//
// Usage:
//   npm run build && node demo/scripts/check-coverage.mjs [--misses]
//
// Reports: share of tickets matching at least one theme (target >= 85%),
// per-theme counts, recall against each ticket's intended theme
// (syntheticTheme in the fixture), and how many emails and phone numbers the
// scrubber redacted from ticket text.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..", "..");
const TICKETS = resolve(root, "demo", "tickets.healthcare-dispatch.json");
const THEMES = resolve(root, "demo", "themes.healthcare-dispatch.json");
const SHOW_MISSES = process.argv.includes("--misses");
const COVERAGE_TARGET = 0.85;

// Theme id in the demo config for each intended-theme key in the fixture.
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

const { FixtureTicketSource } = await import(resolve(root, "dist", "fixture-tickets.js"));
const { formatConversation } = await import(resolve(root, "dist", "format.js"));
const { analyzeFeedback } = await import(resolve(root, "dist", "feedback-analyzer.js"));

const raw = JSON.parse(readFileSync(TICKETS, "utf-8")).conversations;
const intended = new Map(raw.map((c) => [`hs-${c.id}`, c.syntheticTheme]));

const conversations = await new FixtureTicketSource(TICKETS).fetchConversations({
  timeframeDays: 30,
});
const pii = new Set();
const formatted = conversations.map((c) => formatConversation(c, pii));
const config = JSON.parse(readFileSync(THEMES, "utf-8"));
const analysis = analyzeFeedback(formatted, [], config);

// Redaction counts: the scrubber reports categories, not counts, so count
// the placeholders it leaves in the formatted subject and preview.
const countOf = (re) =>
  formatted.reduce((n, c) => n + (`${c.subject} ${c.preview}`.match(re) ?? []).length, 0);
const ticketsWith = (re) => formatted.filter((c) => re.test(`${c.subject} ${c.preview}`)).length;

const matchedIds = new Set(analysis.themes.flatMap((t) => t.data_points.map((d) => d.id)));
const coverage = matchedIds.size / analysis.total_data_points;

console.log(`Tickets in 30-day window: ${analysis.total_data_points} (file has ${raw.length})`);
console.log(
  `Coverage: ${matchedIds.size}/${analysis.total_data_points} = ${(coverage * 100).toFixed(1)}% ` +
    `(target ${COVERAGE_TARGET * 100}%) ${coverage >= COVERAGE_TARGET ? "PASS" : "FAIL"}`
);
console.log("");
console.log("Theme                         matched  recall vs intended");
for (const [key, id] of Object.entries(THEME_ID)) {
  const theme = analysis.themes.find((t) => t.theme_id === id);
  const ids = new Set(theme?.data_points.map((d) => d.id) ?? []);
  const wanted = [...intended].filter(([, k]) => k === key).map(([hsId]) => hsId);
  const hit = wanted.filter((hsId) => ids.has(hsId)).length;
  console.log(
    `${id.padEnd(30)}${String(ids.size).padStart(7)}  ${hit}/${wanted.length}`
  );
  if (SHOW_MISSES) {
    for (const hsId of wanted.filter((w) => !ids.has(w))) {
      const c = formatted.find((f) => `hs-${f.id}` === hsId);
      console.log(`    miss ${hsId}: ${c?.subject} | ${c?.preview.slice(0, 140).replace(/\s+/g, " ")}`);
    }
  }
}

console.log("");
console.log(
  `PII redacted: ${countOf(/\[EMAIL REDACTED\]/g)} emails, ${countOf(/\[PHONE REDACTED\]/g)} phones ` +
    `in ${ticketsWith(/\[(EMAIL|PHONE) REDACTED\]/)} tickets; categories: ${[...pii].join(", ") || "none"}`
);
if (SHOW_MISSES) {
  const unmatched = formatted.filter((c) => !matchedIds.has(`hs-${c.id}`));
  console.log(`\nUnmatched (${unmatched.length}):`);
  for (const c of unmatched) {
    console.log(`  hs-${c.id} [${intended.get(`hs-${c.id}`)}] ${c.subject} | ${c.preview.slice(0, 140).replace(/\s+/g, " ")}`);
  }
}
process.exitCode = coverage >= COVERAGE_TARGET ? 0 : 1;
