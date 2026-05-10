# Contributing

Thanks for your interest. This is a small, focused project. PRs welcome, especially around:

- New customer signal sources (additional MCP-friendly support / roadmap tools)
- Better PII detection (non-US formats, named-entity recognition)
- Test coverage on `src/feedback-analyzer.ts` and `src/pii-scrubber.ts`
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

Node 18 or higher is required.

## Workflow

1. Fork the repo and create a feature branch off `main` (`feature/short-description` or `fix/short-description`).
2. Make your change. Add or update tests where it makes sense.
3. Run the full check locally:
   ```bash
   npm run build
   npm test
   npm run audit:ci
   ```
4. Open a PR against `main`. Fill in the PR template. Link any related issue.
5. CI must pass. A maintainer will review.

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

Open an issue with: what you ran, what you expected, what happened, and the version (`npm ls @dkships/pm-copilot`). Redact any credentials or customer data before posting.

For security issues, see [SECURITY.md](SECURITY.md) — please do not open a public issue.
