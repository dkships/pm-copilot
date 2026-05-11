# Changelog

All notable changes to this project are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows [SemVer](https://semver.org/).

## [Unreleased]

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
