# Changelog

All notable changes to this project are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows [SemVer](https://semver.org/).

## [Unreleased]

### Added

- Chatbase as a third signal class (`src/chatbase.ts`). AI support agent conversations are the
  deflection signal: questions the bot answers never become tickets, so ticket-based
  prioritization undercounts every theme the bot handles, and the gap widens as the bot
  improves. Measured on four AppSumo Originals agents over 30 days — 1,394 conversations
  against 1,678 tickets in the same window, so roughly 83% of the ticket channel was invisible
  to the analysis.
- `SignalType` gains `DEFLECTED`. Deflected signals count toward the frequency term and add
  three per-theme fields (`deflected_count`, `self_serve_failure_rate`, `mean_answer_confidence`),
  but do not enter the severity or vote-momentum terms and do not trigger the 2x convergence
  boost. The scoring formula and methodology version are unchanged: Chatbase does not document
  what its `min_score` field measures, so it is reported as evidence rather than folded into a
  score.
- `agent_name` filter on `synthesize_feedback` and `generate_product_plan`; Chatbase agents
  listed by `list_sources`; a `chatbase` block in `generate_product_plan`'s `preview_only`
  output naming exactly which fields are and are not sent.
- Uses the v1 `/get-conversations` endpoint, not v2 `/conversations/export`. v1 filters
  server-side by date and paginates by page/size; v2 has no date filter and caps at 20 per page
  behind an opaque cursor. v1 also returns `min_score`, and v2's per-message `feedback` field is
  almost never populated on real widget traffic. Both need a Chatbase Standard plan.

- Theme-matching eval harness (`npm run eval`, `src/theme-eval.ts`). Multi-label precision,
  recall and F1 per theme, plus a per-register breakdown and a keyword-collision report.
  Nothing previously measured whether theme assignment was correct — only that the scoring
  mechanics behaved. Ships with a 70-example hand-labelled fixture in `evals/` as a
  regression gate; `--fixture` points it at a local export for a real number, and `--min-f1`
  gives CI a threshold to gate on.
- README `Evaluation` section recording the v2 config baseline (micro F1 77.5%, recall 68.8%)
  and stating the reasoning for keyword matching over embeddings or an LLM classifier.

### Changed

- `themes.config.json` v2 → v3. Two new themes derived from real unmatched conversations —
  Giveaways & Contests and List & Contact Management — taking the config to 18 themes across 12
  categories. Over-generic keywords scoped (`team` → `my team` / `our team` / `teams` /
  `team member` / `team access`; bare `agency`, `form` and `duplicate` removed), duplicated
  keywords assigned to a single theme (`upgrade`/`downgrade` to Account & Licensing, `two factor`
  to Login & Auth), and missing variants added across 13 themes.
- Measured on 1,100 held-out chat conversations from a window the new themes were not derived
  from: unmatched fell from 39.9% to 33.1%. Per product — KingSumo 66.7% → 34.8%,
  SendFox 58.4% → 48.5%, BreezeDoc 25.9% → 23.7%, TidyCal 20.5% → 19.3%.
- Eval CI floor raised from `--min-f1 0.60` to `0.90` now that the fixture gate is meaningful, and
  the eval runs as a CI step so a config edit that drops matching quality fails the build.

### Security

- `npm audit fix` cleared the two high-severity transitive advisories that were failing
  `audit:ci` (`fast-uri` GHSA-v2hh-gcrm-f6hx and related, `ip-address`), plus the remaining
  moderate and low findings. Lockfile-only — no direct dependency ranges changed, and
  `@modelcontextprotocol/sdk` stays within `^1.29.0` at 1.30.0.

### Fixed

- Single-word theme keywords now match a regular plural suffix (`\b<kw>(?:e?s)?\b`). Previously
  `plan` missed "plans" and `tier` missed "tiers", and the config listed plurals only where
  someone had thought of it. On live data this was costly: the recurring widget prompt "what are
  your plans and prices?" matched no theme at all. Irregular plurals still need listing —
  `entry`/`entries` is why the giveaways theme carries both.
- `buildEvidenceSummary` produced `NaN signals` for a `ThemeMatch` without a `deflected_count`.
  The count is now treated as absent rather than added blindly, so an analysis produced before
  the Chatbase source existed still summarises cleanly.
- 429 retries in `HelpScoutClient.apiGet` now read the `X-RateLimit-Retry-After` header
  HelpScout actually sends (per the Mailbox API rate-limiting docs); the code previously
  looked for standard `Retry-After`, which HelpScout omits, so every 429 fell back to blind
  exponential backoff. A non-numeric header value also no longer produces a `setTimeout(NaN)`
  instant retry — it falls back to backoff instead. Standard `Retry-After` is still honoured
  when present. Covered by a new `src/helpscout.test.ts` suite.

### Changed

- `get_feature_requests` fetches portals in parallel instead of one at a time, matching the
  `synthesize_feedback` / `generate_product_plan` path. Per-portal failure isolation and
  warning format are unchanged.

## [1.3.0] — 2026-07-01

### Security

- Bumped transitive `hono` (a `@modelcontextprotocol/sdk` dependency) past the 4.12.x advisories
  flagged high by `npm audit` (GHSA-xrhx-7g5j-rcj5 and related). Lockfile-only change; audit clean.
- Bumped transitive `qs` 6.15.0 → 6.15.2 for GHSA-q8mj-m7cp-5q26 (DoS). Landed in #16
  but was not recorded in this changelog at the time.

### Fixed

- Changelog correction: v1.2.0 also removed the `bin` entry and `npx pm-copilot` support
  added in 1.1.0 (commit c605c10); the 1.2.0 notes omitted the removal. The supported
  install is from source: clone, build, point your MCP client at `dist/index.js`.

- The thread-depth severity signal is live again. Thread bodies were never fetched, so every
  conversation scored `thread_count: 0` and the `min(threads * 10, 50)` severity term always
  contributed nothing. The count now comes from the HelpScout list API's `threads` field (no
  extra API calls). Note: this is the total thread count (including agent replies and notes),
  and a zero/missing count scores as the baseline 1.
- One failing ProductLift portal no longer drops every portal's data from
  `synthesize_feedback` / `generate_product_plan` / `get_feature_requests`. Failures surface
  as per-portal warnings in the response.
- A total fetch failure (all sources down) now returns `isError` instead of an empty analysis
  that reads as a successful result, and failures are never cached.
- Concurrent tool calls no longer interleave PII audit metadata: the module-global category
  log was replaced with an explicit per-request sink. Scrubbing itself was never affected.
- Feature requests are labeled with their actual source portal; previously multi-portal
  fetches stamped every request with the filter value (`"all"`).
- `generate_product_plan` `preview_only` now describes exactly what is fetched and sent.
  It previously claimed comment text and customer message bodies were sent; the analysis
  path fetches neither.
- Unparseable `created_at` dates no longer produce NaN priority scores, and future-dated
  tickets no longer pin severity to the cap.
- PII-redaction placeholders (`[EMAIL REDACTED]` etc.) are stripped before n-gram detection,
  so "email redacted" can no longer surface as an emerging theme.
- A malformed `PRODUCTLIFT_PORTALS` no longer kills the server at startup (taking the
  HelpScout tools with it). The server starts with zero portals and surfaces the config
  error in tool descriptions and `list_sources`. Portal fields are also trimmed now.
- `themes.config.json` load failures return an actionable error naming the path and problem.
- `.env` is now authoritative: load it with `dotenv` `override: true` so a stale variable already
  exported in the shell/parent environment (e.g. an old `PRODUCTLIFT_PORTALS`) no longer shadows
  edits to `.env`. Previously, a pre-set var made `.env` changes appear to have no effect.

### Changed

- `get_feature_requests` responses now include `pii_scrubbing_applied` and
  `pii_categories_redacted`, matching the other tools.
- Commenter names are no longer sent in `get_feature_requests` output — only the commenter
  role (e.g. `admin`). Names were the one identity field that bypassed the scrubbing
  guarantee; this aligns with the existing voter-identity exclusion.
- Upstream API error text is PII-scrubbed before it enters response warnings.
- `.env.example` uses generic portal names (`acme` / `beta`) instead of specific product names,
  matching the `roadmap.example.com` convention used elsewhere in the repo.

### Removed

- The unreachable thread-body fetch path (`includeThreads`, `fetchThreads`, `stripHtml`,
  `extractCustomerMessages`) in `src/helpscout.ts`. No caller ever set `includeThreads`;
  raw thread bodies remain excluded by design pending a privacy review.

## [1.2.0] — 2026-05-31

### Added

- `list_sources` tool — lists configured HelpScout mailboxes (id + name) and ProductLift portals
  (name + url) so you can discover the names to pass to `mailbox_name` / `portal_name`. Read-only;
  projects explicit fields and never returns API keys.
- `mailbox_name` parameter on `synthesize_feedback` and `generate_product_plan` — resolves a
  human-readable mailbox name to its ID via a cached, paginated `GET /v2/mailboxes` lookup, so you
  no longer need to know internal mailbox IDs. `mailbox_id` still works and takes precedence.
- `get_feature_requests`: each request now includes its public `url`, and a `status` filter
  (case-insensitive) narrows results to a single status — removing the need to drop to raw API
  for roadmap-triage reads.
- `generate_product_plan`: `format` parameter. `"markdown"` renders a ready-to-read product brief
  (ranked table + quotes); `"json"` (default) is unchanged for composability.
- Test suite for `src/feedback-analyzer.ts` covering theme matching (word-boundary vs substring),
  severity/vote-momentum scoring, convergence boost, priority sort, and emerging-theme detection.
- `scripts/call-tool.mjs` + `npm run tool` — a local runner to call a tool in isolation (and print
  response byte size) without restarting the MCP client. Not shipped in the npm tarball.

### Changed

- `McpServer` version string corrected from `1.0.0` to match the package version.
- README: documented the new parameters/tool, fixed the credit-card redaction string in the
  security table to match the code (`[CC REDACTED]`), and added Local testing + Troubleshooting
  sections.

### Removed

- Orphaned `fetchStatuses()` and its `Status` interface in `src/productlift.ts` (never called).

## [1.1.1] — 2026-05-10

### Fixed

- `npm pack` no longer includes test files. `tsconfig.json` now excludes `src/**/*.test.ts` from compilation, dropping the tarball from 34 to 30 files. Vitest still reads tests from source.

### Changed

- README badges aligned with installed versions: TypeScript 6.0 and MCP SDK 1.29.0.

## [1.1.0] — 2026-05-10

### Security

- Patched 4 transitive dependency advisories via `npm audit fix`:
  - `fast-uri` path traversal + host confusion ([GHSA-q3j6-qgpj-74h6](https://github.com/advisories/GHSA-q3j6-qgpj-74h6), [GHSA-v39h-62p7-jpjc](https://github.com/advisories/GHSA-v39h-62p7-jpjc)) — HIGH
  - `hono` bodyLimit bypass, JSX/CSS injection, JWT validation, Cache Vary leak — MODERATE
  - `ip-address` XSS in `Address6` HTML methods ([GHSA-v2v4-37r5-5v8g](https://github.com/advisories/GHSA-v2v4-37r5-5v8g)) — MODERATE
  - `express-rate-limit` 8.x range inheriting `ip-address` — MODERATE

- Bounded 429-retry in `HelpScoutClient.apiGet` (`src/helpscout.ts`). Previously could loop indefinitely on persistent rate limiting; now caps at 3 retries with exponential backoff and honours `Retry-After` headers.

- Fixed credit-card redaction regex in `src/pii-scrubber.ts`. The previous pattern only matched 4-digit groups, so Amex cards in their natural `XXXX-XXXXXX-XXXXX` format passed through unredacted even though they Luhn-validate. The new pattern matches any 13–19 digit sequence with optional dash/space separators; the Luhn check below it filters false positives. Found by the new test suite.

- Added `SECURITY.md` with vulnerability disclosure path and PII posture.

- Cleared 5 dev-only moderate advisories in the `esbuild`/`vite` chain — `npm audit` now reports zero vulnerabilities at any severity. Resolved by the vitest 4 upgrade (which switches off the affected bundler chain).

### Added

- `package.json`: `engines.node >= 20`, `files` allowlist (publish only `dist/`, `themes.config.json`, README/LICENSE/SECURITY/CHANGELOG), `bin` entry (`pm-copilot`), `bugs` URL.
- `#!/usr/bin/env node` shebang on `src/index.ts` so `dist/index.js` is directly executable via `npx pm-copilot`.
- `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `CHANGELOG.md`.
- `.github/` directory: CI workflow (build + audit on PRs to `main`), Dependabot config (weekly npm bumps), issue templates, PR template.
- `vitest` dev dependency and tests for `src/pii-scrubber.ts` covering SSN, credit card (Luhn pass/fail), email, and phone redaction.
- `npm run test` and `npm run audit:ci` scripts; `prepublishOnly` gate.

### Changed

- Genericized client-identifying content. The README composability example now uses `Product A` / `Product B` and is framed as illustrative rather than implying live customer data. `src/methodology.ts` no longer names specific products or quotes client-specific churn/scale figures. `CLAUDE.md` and `src/productlift.ts` use `roadmap.example.com` in example URLs. The `AppSumo-specific` block in the support-agent response filter (`src/index.ts`) was dropped; the remaining patterns are generic.
- Bumped major dev/runtime deps: `typescript` 5 → 6, `vitest` 2 → 4, `zod` 3 → 4, `@types/node` 22 → 25.
- Pinned `tsconfig.json` `compilerOptions.types` to `["node"]`. TypeScript 6's implicit `@types/*` inclusion stopped resolving `@types/node` once vitest 4 hoisted `@types/chai`, `@types/deep-eql`, and `@types/estree` as siblings — naming `node` explicitly is the cleanest fix and matches actual usage in `src/`.

### Removed

- The original `AGENTS.md` framing aimed at a single maintainer's toolchain. Replaced with vendor-neutral guidance for any coding agent working in the repo.
- Dropped Node 18 support (end-of-life April 2025). CI matrix and `engines.node` now require Node 20+; modern dev tooling (vitest 4, rolldown, esbuild) no longer runs on Node 18.

## [1.0.0] — 2026-02-19

Initial public release. Server exposes three tools (`synthesize_feedback`, `generate_product_plan`, `get_feature_requests`) and one resource (`pm-copilot://methodology`). HelpScout + ProductLift clients. PII scrubbing for SSN, CC (Luhn), email, phone.
