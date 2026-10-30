#!/usr/bin/env node
// Count sub-patterns inside each theme's tickets, for the README's
// "Insights you can act on" section (build first).
//
// Usage:
//   npm run build && node demo/scripts/count-patterns.mjs [--show]
//
// Tickets per theme are the ones pm-copilot matched to it, after PII
// scrubbing, so the counts line up with the themes table. --show lists the
// subjects behind each count so every regex can be checked by hand.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..", "..");
const TICKETS = resolve(root, "demo", "tickets.healthcare-dispatch.json");
const THEMES = resolve(root, "demo", "themes.healthcare-dispatch.json");
const SHOW = process.argv.includes("--show");

const { FixtureTicketSource } = await import(resolve(root, "dist", "fixture-tickets.js"));
const { formatConversation } = await import(resolve(root, "dist", "format.js"));
const { analyzeFeedback } = await import(resolve(root, "dist", "feedback-analyzer.js"));

const conversations = await new FixtureTicketSource(TICKETS).fetchConversations({ timeframeDays: 30 });
const formatted = conversations.map((c) => formatConversation(c, new Set()));
const byId = new Map(formatted.map((c) => [`hs-${c.id}`, c]));
const analysis = analyzeFeedback(formatted, [], JSON.parse(readFileSync(THEMES, "utf-8")));

// A call-off, or a unit pulled or out of service: the moment a whole
// manifest has to move.
const CALL_OFF = /call(?:s|ed)?[- ]off|calls in sick|out sick|out of service|pulled (?:to|for) a 911|car wouldn't start|lose a unit/i;

const PATTERNS = {
  "calendar-reliability": {
    "early morning or shift change (4–7am, morning rush, first wave)":
      /shift change|hand(?:s)? off to day|handoff|morning rush|first wave|peak|\b[4-7](?::\d\d)?\s?am\b|\b0[4-6]\d\d\b|\b[4-6]:\d\d (?:this|in the) morning|by 5:00/i,
    "Monday or standing-order load": /monday|standing order/i,
    "after a broker import": /\bimport(?:s|ed)?\b|broker file/i,
    "after an update or release": /(?:the|an|last|night's) update\b|release|you pushed|layout changed/i,
    "fell back to paper, phone or radio": /paper|printed|run sheet|by radio|over the radio|radio the|calling drivers|call(?:ed)? the drivers|phone the booking|phoned|by phone|fax/i,
    "missed or late pickup as a result": /missed (?:pickup|dialysis)|late (?:pickup|dialysis|transfer)|past their pickup window|waiting an extra hour|ran late|went out about 30 minutes late|minutes late/i,
  },
  "double-booking": {
    "system-created: broker import or standing order": /\bimport(?:s|ed)?\b|broker file|standing order|recurring/i,
    "two people booked the same trip (dispatchers, schedulers, portal + intake)":
      /two (?:of us|dispatchers|schedulers|of our schedulers)|coworker|second dispatcher|other dispatcher|both (?:dispatchers|of us)|once by our own intake|facility added the same ride|front saw/i,
    "says nothing warned them": /no (?:warning|yellow flag|flag|popup|conflict|overlap check|message)|without (?:any )?warning|nothing (?:flagged|warned|on th)|didn't warn|wasn't warned|did not get any message|accepted (?:it|both)|let(?:s)? (?:me|us|her) (?:add|book)|will let her|allows the same/i,
  },
  "driver-app-sync": {
    "status stuck (en route, arrived)": /stuck on|has said en route|back to en route|status stuck|\barrived\b/i,
    "location lag or jumps": /location|teleport/i,
    "trip or manifest change not reaching the driver": /manifest|never got|cancel|didn't (?:see|get)|doesn't see|never showed/i,
    "dead zone or offline": /offline|dead zone|coverage|lose signal|lose cell/i,
  },
  "driver-reassignment": {
    "call-off or unit out: moving a whole manifest": CALL_OFF,
    "asks for bulk or whole-manifest reassign": /bulk|whole manifest|manifest at once|select the whole|multiple trips|all of them/i,
    "counts the clicks": /\b\d+ clicks|fifteen clicks|eight different/i,
    "round trip: each leg reassigned separately": /\bleg\b|round trip/i,
    "page reload or losing their place": /reload|jumps back|refreshes/i,
  },
  "dispatch-automation": {
    "wants moves proposed or made when a driver calls off or a unit is pulled":
      /(?:call(?:s|ed)?[- ]off|out sick|out of service|pulled for a 911|pulled (?:to|for)|unit is pulled)/i,
    "asks for driver suggestions or auto-assign by location / level of service":
      /suggest|propos|auto-assign|nearest|closest|best available|next available/i,
    "wants a suggestion a dispatcher approves, not full auto":
      /suggest|propos|approve|accept|confirm|override/i,
    "uses the words AI or AI dispatch": /\bai\b/i,
    "mentions a competitor, owner or exec": /competitor|owner|exec|leadership|director|board meeting/i,
    "says fix reliability first": /need the calendar|stop crashing|fix (?:that|the basics)/i,
    "auto-scheduling standing orders": /standing order/i,
  },
};

const results = {};
for (const theme of analysis.themes) {
  const patterns = PATTERNS[theme.theme_id];
  if (!patterns) {
    continue;
  }

  const tickets = theme.data_points.map((dp) => byId.get(dp.id));
  const textOf = (c) => `${c.subject} ${c.preview}`;
  results[theme.theme_id] = { tickets: tickets.length, patterns: {} };
  console.log(`\n== ${theme.label}: ${tickets.length} tickets`);

  for (const [name, re] of Object.entries(patterns)) {
    const hits = tickets.filter((c) => re.test(textOf(c)));
    results[theme.theme_id].patterns[name] = hits.length;
    console.log(`  ${String(hits.length).padStart(3)}  ${name}`);
    if (SHOW) {
      for (const c of hits) {
        const text = textOf(c);
        const at = text.search(re);
        const fragment = text.slice(Math.max(0, at - 40), at + 50).replace(/\s+/g, " ");
        console.log(`         - ${c.subject} :: …${fragment}…`);
      }
    }
  }
}

// Cross-theme: of the tickets asking for automation or AI, how many are
// really asking for help at the call-off moment?
const auto = analysis.themes.find((t) => t.theme_id === "dispatch-automation");
const autoTickets = (auto?.data_points ?? []).map((dp) => byId.get(dp.id));
const callOffAsk = autoTickets.filter((c) =>
  PATTERNS["dispatch-automation"]["wants moves proposed or made when a driver calls off or a unit is pulled"].test(`${c.subject} ${c.preview}`)
);
console.log(`\nAutomation asks tied to a call-off or pulled unit: ${callOffAsk.length}/${autoTickets.length}`);
