# PM Copilot — MCP Server

Product management copilot that connects Claude to customer signal data sources.

## Architecture

- **MCP server** using `@modelcontextprotocol/sdk` with stdio transport
- TypeScript, ES modules, Node 18+
- Two data sources + cross-source analysis:
  - **HelpScout** (support tickets — reactive signal)
  - **ProductLift** (feature requests — proactive signal) — `get_feature_requests` tool
  - **Feedback Analyzer** — `synthesize_feedback` triangulates both sources, scores themes by convergence
  - **Product Planner** — `generate_product_plan` builds prioritized plans with optional KPI context
- MCP resource: `pm-copilot://methodology` — PM planning framework referenced by the planner

## Project Structure

```
src/
  index.ts              # MCP server entry point, tool registration, shared fetch logic
  helpscout.ts          # HelpScout API v2 client (OAuth2 client credentials)
  productlift.ts        # ProductLift API v1 client (Bearer token, multi-portal)
  feedback-analyzer.ts  # Cross-source theme matching, scoring, emerging theme detection
  pii-scrubber.ts       # PII pattern detection and redaction (SSN, CC, email, phone)
  methodology.ts        # PM planning framework exposed as MCP resource
themes.config.json      # Human-editable theme definitions + keywords (project root)
```

## Tools

| Tool | Purpose |
|------|---------|
| `synthesize_feedback` | Cross-reference both sources, return theme analysis with scores. `detail_level`: summary (default, ~20KB), standard (~70KB), full (~560KB) |
| `generate_product_plan` | Build prioritized product plan with evidence + quotes. `detail_level`: summary (default, ~7KB), standard (~21KB), full (~580KB). Accepts `kpi_context` for composability with Metabase/GA MCP servers |
| `get_feature_requests` | Raw ProductLift data browsing |

## Key Decisions

- HelpScout auth: OAuth2 client credentials flow, token cached with 60s expiry buffer
- HelpScout rate limiting: proactive tracking (170 req/min, under 200/min limit)
- Thread fetching: skipped by default for performance; uses subject + preview instead. Optional `includeThreads` flag available.
- HTML stripping: lightweight regex-based (no DOM dependency)
- ProductLift: supports multiple portals (each AppSumo product has its own)
- ProductLift pagination: skip/limit style with `hasMore` flag
- Agent response filtering: 30+ regex patterns detect agent/system text in quote extraction; falls back to ticket subject when preview is agent text
- Detail levels: `summary` (LLM-optimized, <20KB), `standard` (adds titles, <100KB), `full` (all data points, for export). Data point titles capped at 50 per theme in standard mode.
- Feedback analyzer: no ML — keyword matching for known themes, n-gram frequency for emerging themes
- Theme config: loaded at runtime via `fs.readFileSync` so edits don't require rebuild
- Scoring: frequency (0.35) + severity (0.35) + vote momentum (0.30), with 2x convergence multiplier
- Convergence: a theme appearing in BOTH HelpScout and ProductLift gets double priority
- `generate_product_plan` reuses `fetchAndAnalyze()` shared with `synthesize_feedback`
- `kpi_context` is a free-text string — composability hook for other MCP servers
- Partial failure resilience: `Promise.allSettled` in `fetchAndAnalyze()` — one API down returns data from the other + warnings
- Request timeouts: 30s via `AbortSignal.timeout` on all external fetch calls
- Auth errors: distinct error messages for 401/403 that reference the relevant .env variable

## Data Privacy: What We Send and What We Don't

### PII Scrubbing (src/pii-scrubber.ts)

All customer text is scrubbed BEFORE it enters the analysis pipeline or leaves the server:

| Category | Regex Pattern | Validation |
|----------|--------------|------------|
| SSN | `\d{3}[-\s]\d{2}[-\s]\d{4}` | Format match |
| Credit cards | 13-19 digit sequences with separators | Luhn algorithm (reduces false positives) |
| Email addresses | Standard email pattern | Format match |
| Phone numbers | US formats (+1, parens, dashes, dots) | Format match |

Customer email field: **always** replaced with `[REDACTED]`, regardless of pattern matching.

### What We Decided NOT to Send

| Data | Decision | Why |
|------|----------|-----|
| Customer email addresses | Redacted | Not needed for theme analysis; PII risk outweighs utility |
| Agent/admin responses | Excluded | Only customer messages matter for signal analysis; agent replies could leak internal process details |
| Internal HelpScout notes | Excluded | Never fetched; these contain internal discussions, workarounds, and sometimes credentials |
| Attachments | Excluded | Could contain screenshots with PII, invoices, medical documents |
| Voter identities (ProductLift) | Excluded | Vote counts are sufficient; individual identity adds no PM value |
| Commenter emails (ProductLift) | Excluded | Author name included for context, email redacted |
| Raw thread bodies | Excluded after extraction | Only `extractCustomerMessages()` output is used, already stripped of HTML |

### Audit Controls

- `preview_only: true` parameter on `generate_product_plan` returns a manifest of what WOULD be sent without fetching actual data
- Every tool response includes `pii_scrubbing_applied: true` and `pii_categories_redacted: [...]`
- Data category log written to stderr on each call (categories only, never content)

### What This Does NOT Cover

- Names within free text (too many false positives to regex-match reliably)
- Physical addresses (same problem)
- Domain-specific identifiers like order IDs or account numbers (useful for PM analysis, not regulated PII)
- Content of `kpi_context` parameter (passed through verbatim — caller's responsibility)

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `HELPSCOUT_APP_ID` | Yes | OAuth app ID from https://secure.helpscout.net/apps/custom/ |
| `HELPSCOUT_APP_SECRET` | Yes | OAuth app secret |
| `PRODUCTLIFT_PORTALS` | No* | Multi-portal: `name\|url\|key,name2\|url2\|key2` |
| `PRODUCTLIFT_PORTAL_URL` | No* | Single portal URL (e.g., `https://roadmap.tidycal.com`) |
| `PRODUCTLIFT_API_KEY` | No* | Single portal Bearer token |
| `PRODUCTLIFT_PORTAL_NAME` | No | Portal display name (default: "default") |

*At least one ProductLift config needed for `get_feature_requests` to work.

## Development

```bash
npm run build     # Compile TypeScript
npm run dev       # Watch mode
npm start         # Run the server
```

## MCP Server Config (Claude Code)

Already configured via `.mcp.json` (project-scoped). The server loads credentials from `.env` via dotenv.

To re-add manually:
```bash
claude mcp add pm-copilot --scope project -- node /Users/davidkelly/dev/pm-copilot/dist/index.js
```

Restart Claude Code after changes to pick up the MCP server.

## Error Handling

- **Partial failures**: `fetchAndAnalyze()` uses `Promise.allSettled` — if HelpScout is down, ProductLift data still returns (and vice versa). Warnings array in the response tells Claude which source failed.
- **Auth errors**: 401/403 responses produce specific error messages referencing the relevant `.env` variable to check
- **Timeouts**: All external HTTP requests use `AbortSignal.timeout(30_000)` — 30 seconds per request
- **Rate limiting**: HelpScout rate limiter backs off and retries once on 429. Token cache cleared on auth failures.
- **Tool-level**: Each tool handler wraps in try/catch and returns `isError: true` with the message

## Conventions

- Use `registerTool` (not deprecated `.tool()`) and `registerResource` for MCP registration
- All API clients go in their own module (e.g., `helpscout.ts`, `productlift.ts`)
- Return raw structured data from tools — let Claude do the synthesis
- Handle errors gracefully with `isError: true` responses
- PII scrubbing happens at the format layer, before analysis — never send unscrubbed customer text
- No `any` types — API responses use `as T` casts (acceptable since we trust the APIs we call)
- Prefer optional chaining (`?.`) over non-null assertions (`!`)
