# Contributing

Thanks for your interest. This is a small, focused project. PRs welcome, especially around:

- New customer signal sources (additional MCP-friendly support / roadmap tools)
- Better PII detection (non-US formats, named-entity recognition)
- Theme vocabulary improvements that raise recall without new false positives (check with `npm run eval`)
- Bug fixes with a regression test

## Getting set up

```bash
git clone https://github.com/dkships/pm-copilot.git
cd pm-copilot
npm install
cp .env.example .env   # fill in test credentials
npm run build
npm test
```

Node 20 or higher is required.

## Workflow

1. Fork the repo and create a feature branch off `main` (`feature/short-description` or `fix/short-description`).
2. Make your change. Add or update tests where it makes sense.
3. Run the full check locally:
   ```bash
   npm run build
   npm run typecheck
   npm test
   npm run eval -- --min-f1 0.90
   npm run audit:ci
   ```
   CI runs the same checks.
4. Open a PR against `main`. Fill in the PR template. Link any related issue.
5. CI must pass. A maintainer will review.

## Commands

```bash
npm run build        # Compile TypeScript
npm run dev          # Watch mode
npm start            # Run the server
npm test             # Vitest unit tests
npm run typecheck    # Type-check src and tests
npm run eval         # Theme-matching eval (see docs/evaluation.md)
npm run audit:ci     # Dependency audit gate
```

MCP clients run the compiled `dist/`, so rebuild and restart the client after source changes.

### Local testing

Call a tool in isolation without restarting your MCP client. Useful for iterating on changes and checking response sizes:

```bash
npm run build
npm run tool -- --list
npm run tool -- list_sources '{}'
npm run tool -- get_feature_requests '{"portal_name":"<your-portal>","status":"open"}'
```

The runner prints the byte size of each response. Output may include your configured source names and URLs (and PII-scrubbed customer text), so redact before sharing.

## Code style

- TypeScript strict mode is on. No `any` — use `as T` casts at API boundaries with a comment if the API response shape isn't obvious.
- Prefer optional chaining (`?.`) over non-null assertions (`!`).
- Use `registerTool` and `registerResource` (not deprecated `.tool()`).
- New API clients go in their own module (`src/<source>.ts`).
- Tools return raw structured data. Let the LLM do synthesis.
- PII scrubbing happens at the format layer, before text leaves the process. Do not bypass this for new data sources.

## Commit messages

Short, imperative, present tense. Examples:

```
Add Linear client for issue tracking
Fix off-by-one in vote momentum scoring
Bump @modelcontextprotocol/sdk to 1.30
```

No "feat:" / "fix:" prefixes required.

## Reporting bugs

Open an issue with: what you ran, what you expected, what happened, and the version (the `version` from `package.json`, or the commit SHA you built from). Redact any credentials or customer data before posting.

For security issues, see [SECURITY.md](SECURITY.md) — please do not open a public issue.
