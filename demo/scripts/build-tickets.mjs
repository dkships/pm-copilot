#!/usr/bin/env node
// Build the synthetic HelpScout-shaped fixture from the authored ticket text.
//
// Usage:
//   node demo/scripts/build-tickets.mjs                       # dates relative to now
//   node demo/scripts/build-tickets.mjs --now 2026-10-30T20:00:00Z
//
// Ticket wording lives in ticket-texts.json; this script only adds the
// metadata a HelpScout list response carries (ids, dates, status, tags, thread
// counts). It is seeded, so a rerun with the same --now gives the same file.
// Rerun before recording if the tickets have aged out of the 30-day window.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const TEXTS = resolve(here, "ticket-texts.json");
const OUT = resolve(here, "..", "tickets.healthcare-dispatch.json");

const args = process.argv.slice(2);
const nowArg = args.includes("--now") ? args[args.indexOf("--now") + 1] : null;
const NOW = nowArg ? Date.parse(nowArg) : Date.now();
if (Number.isNaN(NOW)) {
  throw new Error(`Invalid --now value: ${nowArg}`);
}

const SEED = 20261030;
const DAY_MS = 24 * 60 * 60 * 1000;
const WINDOW_DAYS = 29.5; // inside a 30-day timeframe with a little margin
const FIXTURE_MAILBOX_ID = 1;
const FIRST_ID = 4_100_001;
const FIRST_NUMBER = 18_201;
const FIRST_TAG_ID = 901;

// Thread count range and severity-tag odds per theme. Outages and
// double-bookings escalate; UX friction and feature asks mostly don't.
const THEME_PROFILE = {
  calendar: { tag: "calendar", threads: [2, 7], bug: 0.55, urgent: 0.3, escalation: 0.12 },
  double_booking: { tag: "double-booking", threads: [2, 6], bug: 0.45, urgent: 0.3, escalation: 0.1 },
  reassignment: { tag: "trip-reassignment", threads: [1, 4], bug: 0.05, urgent: 0.05, escalation: 0 },
  driver_app: { tag: "driver-app", threads: [2, 5], bug: 0.4, urgent: 0.15, escalation: 0.05 },
  notifications: { tag: "notifications", threads: [1, 4], bug: 0.25, urgent: 0.1, escalation: 0.05 },
  reporting: { tag: "reporting", threads: [1, 4], bug: 0.2, urgent: 0.1, escalation: 0 },
  permissions: { tag: "user-access", threads: [1, 3], bug: 0.1, urgent: 0.15, escalation: 0 },
  automation: { tag: "feature-request", threads: [1, 2], bug: 0, urgent: 0, escalation: 0 },
};

const ROLE_EMAIL = {
  dispatcher: "dispatch",
  ops_manager: "ops",
  admin: "admin",
  facility_coordinator: "transport.coord",
};

// mulberry32: small seeded PRNG, so the fixture is reproducible.
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

// One stable id per tag name, as HelpScout assigns them.
const TAG_IDS = new Map();
const tagId = (tag) => {
  if (!TAG_IDS.has(tag)) TAG_IDS.set(tag, FIRST_TAG_ID + TAG_IDS.size);
  return TAG_IDS.get(tag);
};

const rand = prng(SEED);
const between = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));
const chance = (p) => rand() < p;

const { tickets: texts } = JSON.parse(readFileSync(TEXTS, "utf-8"));

// Shuffle so ids and dates don't cluster by theme.
const order = texts.map((_, i) => i);
for (let i = order.length - 1; i > 0; i--) {
  const j = Math.floor(rand() * (i + 1));
  [order[i], order[j]] = [order[j], order[i]];
}

const conversations = order.map((textIndex, i) => {
  const t = texts[textIndex];
  const profile = THEME_PROFILE[t.theme];
  if (!profile) {
    throw new Error(`Unknown theme "${t.theme}" in ticket-texts.json entry ${textIndex}`);
  }

  // Spread across the window; keep times to a 05:00–23:00 UTC working day.
  const ageDays = rand() * WINDOW_DAYS;
  const created = new Date(NOW - ageDays * DAY_MS);
  created.setUTCHours(between(5, 22), between(0, 59), between(0, 59), 0);
  if (created.getTime() > NOW) {
    created.setTime(NOW - between(5, 120) * 60_000);
  }

  // Older tickets are mostly closed; the last few days are mostly open.
  const closedOdds = ageDays > 7 ? 0.75 : ageDays > 2 ? 0.4 : 0.1;
  const status = chance(closedOdds) ? "closed" : chance(0.6) ? "active" : "pending";
  const closedAt =
    status === "closed"
      ? new Date(
          Math.min(created.getTime() + between(2, 72) * 60 * 60_000, NOW)
        ).toISOString()
      : null;

  const tagNames = ["synthetic", profile.tag];
  if (t.also && THEME_PROFILE[t.also]) {
    tagNames.push(THEME_PROFILE[t.also].tag);
  }
  if (chance(profile.bug)) tagNames.push("bug");
  if (chance(profile.urgent)) tagNames.push("urgent");
  if (chance(profile.escalation)) tagNames.push("escalation");

  return {
    id: FIRST_ID + i,
    number: FIRST_NUMBER + i,
    subject: t.subject,
    status,
    state: "published",
    mailboxId: FIXTURE_MAILBOX_ID,
    createdAt: created.toISOString(),
    closedAt,
    tags: [...new Set(tagNames)].map((tag) => ({ id: tagId(tag), tag })),
    primaryCustomer: { email: `${ROLE_EMAIL[t.role] ?? "support"}${i}@example.com` },
    preview: t.body,
    threads: between(...profile.threads),
    // Not HelpScout fields: kept for readers of this file, dropped by the
    // fixture loader before anything reaches the analysis.
    writerRole: t.role,
    customerType: t.org,
    syntheticTheme: t.theme,
    ...(t.also && { syntheticSecondaryTheme: t.also }),
  };
});

conversations.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));

const fixture = {
  _note:
    "SYNTHETIC DATA. 200 invented support tickets modeled on healthcare transport " +
    "dispatch software. No real customers, patients or staff. Generated by " +
    "demo/scripts/build-tickets.mjs from demo/scripts/ticket-texts.json.",
  generated_at: new Date(NOW).toISOString(),
  conversations,
};

writeFileSync(OUT, JSON.stringify(fixture, null, 2) + "\n");
console.log(`Wrote ${conversations.length} tickets to ${OUT}`);
