# PM Copilot — MCP Server

MCP server connecting an LLM to customer signal data (HelpScout support tickets + ProductLift feature requests). Architecture and quickstart: README.md. Contributor process: CONTRIBUTING.md.

## Commands

```bash
npm run build       # Compile TypeScript (also chmods dist/index.js)
npm run dev         # Watch mode
npm test            # Vitest unit tests
npm start           # Run the server
npm run tool -- <tool_name> '<json-params>'  # Call one tool directly, no MCP client (use --list to enumerate)
npm run audit:ci    # Dependency audit gate (prepublishOnly runs build + test + this)
```

Run `npm run build` after source changes before testing through an MCP client — clients execute `dist/index.js`. Restart Claude Code to pick up server changes. The server is registered via the project-scoped `.mcp.json`; re-add with `claude mcp add pm-copilot --scope project -- node dist/index.js`.

## PII guardrails (load-bearing for any PR)

- Scrub patterns live in `src/pii-scrubber.ts` (SSN, Luhn-validated credit cards, email addresses, phone numbers); they are applied in `src/format.ts` before text enters analysis or leaves the server. Customer email field is always `[REDACTED]` regardless of match.
- Never send unscrubbed customer text. New customer data sources must route through the format layer.
- Excluded by design (don't add without scoping a privacy review): agent/admin responses, internal HelpScout notes, attachments, voter identities, commenter names and emails, raw thread bodies. `kpi_context` is passed through verbatim — caller's responsibility.
- Every tool response includes `pii_scrubbing_applied: true` and `pii_categories_redacted: [...]`. `preview_only: true` on `generate_product_plan` returns a manifest without fetching data.

## Environment variables

Loaded from `.env` via dotenv with `override: true` — `.env` values win over already-exported shell vars (intentional; don't "fix" it). Never commit values.

| Variable | Required | Description |
|----------|----------|-------------|
| `HELPSCOUT_APP_ID` | Yes | OAuth app ID from https://secure.helpscout.net/apps/custom/ |
| `HELPSCOUT_APP_SECRET` | Yes | OAuth app secret |
| `PRODUCTLIFT_PORTALS` | No* | Multi-portal: `name\|url\|key,name2\|url2\|key2` |
| `PRODUCTLIFT_PORTAL_URL` | No* | Single portal URL |
| `PRODUCTLIFT_API_KEY` | No* | Single portal Bearer token |
| `PRODUCTLIFT_PORTAL_NAME` | No | Portal display name (default: "default") |

*At least one ProductLift config needed for `get_feature_requests` to work.

## Conventions

- Use `registerTool` / `registerResource` for MCP registration (not deprecated `.tool()`)
- All API clients go in their own module (e.g., `helpscout.ts`, `productlift.ts`)
- Return raw structured data from tools — let the LLM do the synthesis
- Handle errors gracefully with `isError: true` responses; partial failures return data from the working source plus a `warnings` array
- No `any` types — API responses use `as T` casts at API boundaries
- Prefer optional chaining (`?.`) over non-null assertions (`!`)
- `themes.config.json` is read at runtime (`fs.readFileSync`) — theme edits don't require a rebuild

## Accuracy

- Check `helpscout.ts` and `productlift.ts` before claiming API capabilities; do not assume.
- Verify functions, types, and config keys exist in the codebase before referencing them.
