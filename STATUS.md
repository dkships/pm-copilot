# PM Copilot — Status & Context for Planning

Last updated: 2026-02-18 (end of build session 2)

## What This Is

An MCP server that triangulates customer signals across HelpScout (support tickets) and ProductLift (feature requests) to generate prioritized product plans for AppSumo Originals products (BreezeDoc, TidyCal, FormRobin).

**The core insight:** A theme appearing in BOTH support tickets (reactive) AND feature requests (proactive) is a much stronger signal than either alone. These "convergent" signals get a 2x priority boost.

## Current State: Working End-to-End with Real Data

Both APIs are authenticated and returning real data. The full pipeline runs in ~55 seconds.

### Last Run Results (2026-02-18, 30-day window, Originals mailbox)

| Metric | Value |
|--------|-------|
| HelpScout tickets analyzed | 2,136 |
| ProductLift requests analyzed | 234 |
| Total signals | 2,370 |
| Themes matched | 16 of 16 active |
| Convergent themes | 15 of 16 |
| Unmatched signals | 563 (24%) |
| Pipeline time | ~55 seconds |
| PII categories scrubbed | phone, email |

### Top Priorities from Real Data

| # | Theme | Score | Tickets | Requests | Convergent |
|---|-------|-------|---------|----------|------------|
| 1 | Booking & Scheduling | 134.6 | 629 | 77 | Yes |
| 2 | Account & Licensing | 74.5 | 628 | 8 | Yes |
| 3 | Whitelabel & Branding | 54.6 | 53 | 30 | Yes |
| 4 | Billing & Payment | 43.1 | 195 | 20 | Yes |
| 5 | Performance & Bugs | 33.2 | 276 | 7 | Yes |
| 6 | Templates & Editor | 32.7 | 80 | 38 | Yes |
| 7 | Notifications & Reminders | 31.8 | 113 | 19 | Yes |
| 8 | Email & Delivery | 31.2 | 110 | 6 | Yes |
| 9 | Team & Collaboration | 30.9 | 217 | 19 | Yes |
| 10 | Customization | 26.2 | 128 | 20 | Yes |

## What's Built

### Tools

| Tool | Status | What It Does |
|------|--------|-------------|
| `synthesize_feedback` | Working | Cross-references both sources, returns theme analysis with convergence detection |
| `generate_product_plan` | Working | Builds prioritized plan with evidence summaries + customer quotes. Accepts `kpi_context` for composability with Metabase/GA |
| `get_feature_requests` | Working | Raw ProductLift data browsing |

### MCP Resource

`pm-copilot://methodology` — PM planning framework that Claude reads when generating plans. Currently AI-generated content. Covers signal types, weighting rules, scoring formula, anti-patterns.

### Data Sources Connected

| Source | Auth | Portals/Mailboxes |
|--------|------|-------------------|
| HelpScout | OAuth2 client credentials | Originals mailbox (272363) + 5 others available |
| ProductLift (BreezeDoc) | Bearer token | 265 posts, roadmap.breezedoc.com |
| ProductLift (TidyCal) | Bearer token | 628 posts, roadmap.tidycal.com |
| ProductLift (FormRobin) | Bearer token | 96 posts, roadmap.formrobin.com |

### Architecture

```
src/
  index.ts              # MCP server, 3 tools, 1 resource, shared fetch pipeline
  helpscout.ts          # HelpScout API v2 client (OAuth2, rate limiting, 30s timeouts)
  productlift.ts        # ProductLift API v1 client (multi-portal, skip/limit pagination)
  feedback-analyzer.ts  # Theme matching, scoring, emerging theme detection (n-gram)
  pii-scrubber.ts       # PII redaction (SSN, credit cards w/ Luhn, emails, phones)
  methodology.ts        # PM planning framework (MCP resource content)
themes.config.json      # 16 themes, ~170 stop words (loaded at runtime, no rebuild needed)
```

### Scoring Formula

```
priority = (frequency × 0.35 + severity × 0.35 + vote_momentum × 0.30) × convergence_boost
```

- Frequency: data point count, normalized across themes
- Severity: reactive only — recency (7-day half-life), tag boosts (bug/urgent/escalation)
- Vote momentum: proactive only — 80% votes + 20% comments
- Convergence: 2x boost when theme appears in both HelpScout AND ProductLift

### Data Privacy

- PII scrubbed before analysis: SSN, credit cards (Luhn validated), emails, phone numbers
- Customer email always `[REDACTED]`
- Agent responses, internal notes, and attachments excluded
- `preview_only` mode for auditing data flow without fetching
- Response metadata includes `pii_scrubbing_applied` and categories scrubbed

## What Was Fixed During Testing

These are bugs found and fixed when running against real APIs (not caught during scaffolding):

1. **ProductLift pagination** — Assumed Laravel-style `meta.last_page`. Real API uses `skip/limit/hasMore`. Was only fetching 10 posts per portal instead of all. Fixed.
2. **ProductLift token parsing** — API tokens contain `|` characters (`231|abc...`), colliding with the `|` delimiter in the multi-portal env var format. Fixed parser to split correctly.
3. **HelpScout thread fetching performance** — Fetching threads for each conversation (N+1 calls) took 4+ minutes for 2,100 conversations. Changed to skip thread fetching for analysis (subject + preview is sufficient for theme matching). Pipeline went from 4+ min to ~55 seconds.
4. **Null preview crash** — `scrubPii(conv.preview)` crashed when preview was undefined. Added null guards.
5. **Agent response contamination** — HelpScout preview field contains the most recent message, often an agent response. This polluted emerging themes with "happy to help", "let me know", etc. Added ~50 agent-boilerplate stop words.
6. **Theme coverage** — Original 8 generic themes only matched 21% of data. Replaced with 16 data-driven themes matching 76%+ of signals. All convergent.

## What's Still Outstanding

### Must Do

- [ ] **Initial git commit** — Everything is untracked. Nothing committed yet.
- [ ] **Review methodology content** — `src/methodology.ts` has AI-generated PM framework text. You said you'd provide the actual planning framework. This directly shapes how Claude generates product plans.
- [ ] **Output size management** — `synthesize_feedback` returns 624KB of JSON (all data points per theme). Needs a `detail_level` parameter or summary mode for LLM consumption vs. dashboard consumption.

### Should Do

- [ ] **Agent response filtering** — The `preview` field still contains agent text. Either: (a) filter previews that start with agent language patterns, or (b) add a `source` field to previews, or (c) only use the `subject` field for theme matching (losing some signal but eliminating contamination).
- [ ] **Mailbox name resolution** — Tools require `mailbox_id: "272363"`. Should accept `mailbox_name: "Originals"` and resolve it.
- [ ] **Automated tests** — No test suite. Scoring algorithm, PII scrubber, and theme matching are good candidates.
- [ ] **`generate_product_plan` customer quotes** — Currently pulls from preview text, which includes agent responses. Quotes should be filtered to customer voice only.

### Future / v2

- [ ] **Composability demo** — Run `generate_product_plan` with real `kpi_context` from Metabase MCP server (churn data) + GA MCP server (traffic). This is the "demo moment" that shows cross-MCP-server composition.
- [ ] **Weekly automated review** — Scheduled run of `generate_product_plan`, diff against previous week, post to Slack or Linear.
- [ ] **Per-product filtering** — Currently analyzes all products together. Should support `product: "tidycal"` to scope analysis to one product's mailbox + portal.
- [ ] **Theme auto-tuning** — Analyze unmatched signals, cluster them, suggest new themes for human approval.
- [ ] **MCP App v2** — Return structured UI components (priority matrix, interactive reordering) instead of raw JSON.

## File Tree

```
pm-copilot/
├── .env                  # Real credentials (gitignored)
├── .env.example          # Credential template
├── .gitignore
├── .mcp.json             # Claude Code MCP server config
├── CLAUDE.md             # Project instructions for Claude Code sessions
├── README.md             # Public documentation (13 sections)
├── HANDOFF.md            # Build handoff from session 1 (stale — this file supersedes it)
├── STATUS.md             # This file
├── package.json          # v0.2.0, MIT
├── package-lock.json
├── tsconfig.json
├── themes.config.json    # 16 data-driven themes + 170 stop words (runtime loaded)
├── src/
│   ├── index.ts          # MCP server, 3 tools, 1 resource, fetch pipeline
│   ├── helpscout.ts      # HelpScout API v2 client
│   ├── productlift.ts    # ProductLift API v1 client (multi-portal)
│   ├── feedback-analyzer.ts  # Theme matching, scoring, emerging themes
│   ├── pii-scrubber.ts   # PII detection + redaction
│   └── methodology.ts    # PM planning framework (MCP resource)
├── dist/                 # Compiled JS (tsc output)
├── claude-code-notes.md  # Personal field notes (gitignored)
└── moonshot-ideas.md     # Product ideas from the build (gitignored)
```

## Credentials

Centralized in `~/.env.secrets` (sourced by shell):
- `HELPSCOUT_APP_ID` / `HELPSCOUT_APP_SECRET` — OAuth2 client credentials
- `PRODUCTLIFT_{BREEZEDOC,TIDYCAL,FORMROBIN}_{URL,KEY}` — Per-portal API tokens

Project `.env` consumes these for the MCP server runtime.

## Dependencies

```json
{
  "@modelcontextprotocol/sdk": "^1.11.0",
  "zod": "^3.24.0",
  "dotenv": "^16.4.0"
}
```

Zero ML dependencies. Theme matching is keyword-based. Emerging themes use bigram/trigram frequency analysis.
