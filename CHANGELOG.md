# Changelog

All notable changes to this project are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows [SemVer](https://semver.org/).

## [Unreleased]

## [1.8.0] — 2026-09-23

HelpScout becomes optional.

### Changed

- HelpScout is optional. The server runs with any one of HelpScout, ProductLift or Chatbase
  configured, and exits only when none is. Without HelpScout there are no tickets, so themes get
  no severity score and no convergence boost. Setting one HelpScout variable without the other is
  a config error, reported without echoing the value. A mailbox filter given without HelpScout
  warns instead of being silently ignored. `list_sources` adds `helpscout_configured`. The
  `.env.example` HelpScout lines are now commented out, so copying it doesn't configure fake
  credentials. Without HelpScout, every analysis carries a note that ticket counts are absent,
  not zero, so the methodology's "votes without tickets is a want" rule isn't misapplied.
- The markdown product plan now shows warnings; it used to drop them.

### Fixed

- A HelpScout 403 after a successful token request now says what it usually means: the user who
  owns the OAuth app lost access, so rotating the secret won't help and a new app is needed.

## [1.7.0] — 2026-09-23

A drill-down from a ranked theme to the records behind it.

### Added

- `get_theme_evidence`: drill into one theme and get the tickets, feature requests and chats
  behind it, with ticket numbers, request URLs, votes, channels and dates. It reuses the analysis
  cache when called with the same filters (a live call returned in 2ms). `limit` applies per
  source, so 244 chats can't bury 23 feature requests. Returns identifiers, metadata and scrubbed
  titles; a chat's opening message is truncated to 200 characters like a quote. HelpScout web
  links are not built, because the URL format couldn't be verified; ticket numbers are returned
  instead.

### Changed

- `zod` 4.4.3 → 4.6.5 and `@types/node` 26.2.0 → 26.6.2 (#41). Published tool schemas are
  byte-identical under the new `zod`.

## [1.6.0] — 2026-09-22

Opt-in comment analysis, bounded feature-request fetches, and much faster ProductLift paging.

### Added

- `include_comments` on `synthesize_feedback` and `generate_product_plan` (default off). Customer
  comment text is scrubbed, commenter names and admin replies are dropped, and it feeds theme
  matching and quotes. The gain is modest: on live data 7 of 18 themes picked up 1-3 extra
  feature-request matches, and unmatched signals barely moved (358 to 357). It costs one call per
  request with comments against ProductLift's 120-a-minute limit; a call on four portals took
  ~51s, close to the 60s client timeout. `preview_only` lists it when on.
- `limit` and `sort` (`votes` / `recent`) on `get_feature_requests`, applied per portal before
  comments are fetched.

### Changed

- ProductLift post pages and comment calls run 6 at a time. The first page reports the total, so
  the rest are fetched in parallel, and a failed page stops the others. A 544-post portal went
  from ~50s to ~11s including comments, and a cold analysis from 46s to ~8-13s.
  ProductLift's Retry-After cap is now its 60s rate window.
- Chatbase's fallback 429 backoff is 2s/4s/8s. The old 1s/2s/4s fit inside its 10s rate window,
  so all three retries could fail.
- The two analysis tools share one filter schema and fetch helper.

## [1.5.0] — 2026-09-22

A reliability, privacy and docs pass. Scores shift slightly, so the methodology moves to v2.2.

### Added

- `source_filter` on the analysis tools, per-channel counts (`chatbase_sources`), and
  `chatbase_conversation_sources` in `list_sources` (#38).
- Read-only tool annotations on all four tools.
- `npm run typecheck`, which type-checks the test files. CI runs it, and now also runs on Node 24.

### Fixed

- **PII:** the email pattern ran in quadratic time on long dotted or dashed runs (20k characters
  took ~2.5s), and chat text is unbounded. Its quantifiers are now bounded. The scrubber also
  catches `+`-prefixed international phone numbers (not after `GMT`/`UTC`, not before a year).
  Feature-request URLs are scrubbed too, since ProductLift builds the slug from the title. Error
  messages returned to the client are scrubbed on every path.
- A malformed `PRODUCTLIFT_PORTALS` or `CHATBASE_AGENTS` entry was echoed, a pasted API key
  included, into tool descriptions and `list_sources`. Errors now name the entry number only.
- dotenv 17 printed a banner to stdout, which is the MCP protocol channel.
- A null description, comment body or comment author from ProductLift crashed the formatter and
  dropped the whole portal.
- A result where any source failed was cached for 5 minutes. It's now cached for 30 seconds, and
  `fetched_at` reports when the data was actually fetched.
- ProductLift: 429s are retried instead of failing the portal, paging stops at 500 pages, a
  malformed page fails the portal instead of truncating the list, and failed comment fetches
  produce a warning instead of an empty list.
- HelpScout re-authenticates once on a 401 and retries a 5xx, instead of discarding every page
  already fetched. Retry-After values over 60s (HelpScout) or 30s (ProductLift, Chatbase) fail fast
  instead of sleeping inside a tool call.
- Chatbase filters by whole UTC days, which let in up to a day of extra chats (a 1-day window
  could return nearly two). Results are trimmed to the exact window.
- An unknown `portal_name` on the analysis tools now warns, as `agent_name` already did.
- An informational warning (unknown `source_filter`) no longer counts as a Chatbase failure.
- `.env` is loaded from the repo root, not the working directory. Claude Desktop launches the
  server elsewhere, so it exited with "Missing HELPSCOUT_APP_ID". A `.env` in the working
  directory is no longer read.
- **Scoring (methodology v2.2):** recency used `exp(-age/7)`, a 4.85-day half-life, against the
  documented 7 days. The tag boost took the first matching tag, so HelpScout's tag order changed
  the score; it now takes the highest. Multi-word keywords matched as raw substrings ("sign in"
  fired on "design in"); they now match on word boundaries. Keywords that only worked as stems
  (`calendar connect`, `form submit`) gained explicit variants, with fixture rows covering them.
  Theme eval: micro F1 0.975 on 86 examples.

### Changed

- `get_feature_requests` skips the comment call for posts reporting zero comments (39s to ~5s on
  a 72-post portal), and each portal's post list is cached for 5 minutes, so varying parameters
  no longer re-downloads every post.
- Tool responses are compact JSON, about 20-26% fewer tokens. `npm run tool` still pretty-prints.
- The server reads its version from `package.json`.
- README cut from 27.7KB to ~13.6KB. Evaluation detail moved to `docs/evaluation.md`, the PII
  exclusions to `SECURITY.md`, and the dev commands to `CONTRIBUTING.md`. Stale facts fixed across
  `AGENTS.md`, `SECURITY.md`, `CONTRIBUTING.md` and the issue template.
- Transitive `fast-uri`, `hono` and `qs` updated; `npm audit` had been failing CI on a high
  `fast-uri` advisory.
- **TypeScript 6.0.3 → 7.0.2** (#28), **`@types/node` 25.9.1 → 26.2.0** (#32), and
  **`actions/setup-node` 6 → 7** (#30). Three major bumps, no source changes needed for any of
  them. Verified together before merging, not just individually: `tsc --noEmit` clean, build
  clean, 124 tests, theme-matching eval at micro F1 0.974, `npm audit` clean, and a live
  `list_sources` call returning the expected sources. Emitted `dist/index.js` is byte-comparable.
- `skipLibCheck: true` still suppresses type problems inside `node_modules`, so a clean
  typecheck speaks for this repo's code, not its dependencies' type definitions.

## [1.4.1] — 2026-08-10

A privacy and accuracy patch. No functional change — build, tests, eval and audit are identical to
1.4.0. Released as its own version so the source tarball people download matches the repo's
de-identification policy, rather than moving the 1.4.0 tag.

### Fixed

- Restored the de-identification policy recorded in the 1.2.0 entry below. The 1.4.0 docs had
  reversed it: the README carried a per-product results table naming four real products with
  their conversation volumes and unmatched rates, this changelog named the client outright, and
  test fixtures used real product names as example agent names. Products are now `Product A`–`D`,
  the client is unnamed, and example agents are `portal-a` / `portal-b`. Aggregate figures remain,
  which the policy always allowed — it was the named per-product attribution that did not belong.
- Six lines in `evals/theme-matching.jsonl` were verbatim or near-verbatim real customer chat
  messages rather than the synthetic text the fixture is documented to contain. They carried no
  PII — short product questions, no names, addresses or identifiers — but real customer wording
  does not belong in a public fixture. Replaced with invented phrasings that exercise the same
  keywords; both new themes still score 100% and micro F1 is unchanged at 0.974.
- `server.json` declared an `@dkships/pm-copilot` npm package that does not exist and is not
  planned. The `packages` block is removed; the manifest now describes the server without
  claiming a distribution channel. Distribution is the GitHub release plus clone-and-build.
- The bug-report template and CONTRIBUTING asked reporters for `npm ls @dkships/pm-copilot`,
  which cannot work for a clone-and-build install. Both now ask for the `package.json` version or
  the commit SHA.
- The Chats and Self-serve fail columns added to the README composability table held real measured
  values inside a table the caption describes as illustrative. Now genuinely illustrative.

## [1.4.0] — 2026-08-10

### Added

- Chatbase as a third signal class (`src/chatbase.ts`). AI support agent conversations are the
  deflection signal: questions the bot answers never become tickets, so ticket-based
  prioritization undercounts every theme the bot handles, and the gap widens as the bot
  improves. Measured on four AI support agents, one per product, over 30 days — 1,394 conversations
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
- Registry publication metadata: `bin` entry, `mcpName`, and a matching `server.json` declaring
  the HelpScout, ProductLift and Chatbase environment variables.

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
  from: unmatched fell from 39.9% to 33.1%. Per product — Product D 66.7% → 34.8%,
  Product B 58.4% → 48.5%, Product C 25.9% → 23.7%, Product A 20.5% → 19.3%.
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

- Genericized client-identifying content. The README composability example now uses `Product A` / `Product B` and is framed as illustrative rather than implying live customer data. `src/methodology.ts` no longer names specific products or quotes client-specific churn/scale figures. `CLAUDE.md` and `src/productlift.ts` use `roadmap.example.com` in example URLs. A client-specific block in the support-agent response filter (`src/index.ts`) was dropped; the remaining patterns are generic.
- Bumped major dev/runtime deps: `typescript` 5 → 6, `vitest` 2 → 4, `zod` 3 → 4, `@types/node` 22 → 25.
- Pinned `tsconfig.json` `compilerOptions.types` to `["node"]`. TypeScript 6's implicit `@types/*` inclusion stopped resolving `@types/node` once vitest 4 hoisted `@types/chai`, `@types/deep-eql`, and `@types/estree` as siblings — naming `node` explicitly is the cleanest fix and matches actual usage in `src/`.

### Removed

- The original `AGENTS.md` framing aimed at a single maintainer's toolchain. Replaced with vendor-neutral guidance for any coding agent working in the repo.
- Dropped Node 18 support (end-of-life April 2025). CI matrix and `engines.node` now require Node 20+; modern dev tooling (vitest 4, rolldown, esbuild) no longer runs on Node 18.

## [1.0.0] — 2026-02-19

Initial public release. Server exposes three tools (`synthesize_feedback`, `generate_product_plan`, `get_feature_requests`) and one resource (`pm-copilot://methodology`). HelpScout + ProductLift clients. PII scrubbing for SSN, CC (Luhn), email, phone.
