# PM Copilot — MCP Server

Product management copilot that connects Claude to customer signal data sources. README has architecture, mermaid diagram, and quickstart.

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

## PII guardrails (load-bearing for any PR)

PII scrubbing happens in `src/pii-scrubber.ts` before text enters analysis or leaves the server. Categories: SSN, credit cards (Luhn-validated), email addresses, phone numbers. Customer email field is always `[REDACTED]` regardless of match.

Excluded by design (don't add without scoping a privacy review): agent/admin responses, internal HelpScout notes, attachments, voter identities, commenter emails, raw thread bodies. `kpi_context` is passed through verbatim — caller's responsibility.

Every tool response includes `pii_scrubbing_applied: true` and `pii_categories_redacted: [...]`. `preview_only: true` on `generate_product_plan` returns a manifest without fetching data.

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
claude mcp add pm-copilot --scope project -- node dist/index.js
```

Restart Claude Code after changes to pick up the MCP server.

## Accuracy

- Check `helpscout.ts` and `productlift.ts` before claiming API capabilities; do not assume.
- Verify functions, types, and config keys exist in the codebase before referencing them.

Hallucination prevention: see `~/.agents/AGENTS.md`.

## Conventions

- Use `registerTool` (not deprecated `.tool()`) and `registerResource` for MCP registration
- All API clients go in their own module (e.g., `helpscout.ts`, `productlift.ts`)
- Return raw structured data from tools — let Claude do the synthesis
- Handle errors gracefully with `isError: true` responses
- PII scrubbing happens at the format layer, before analysis — never send unscrubbed customer text
- No `any` types — API responses use `as T` casts (acceptable since we trust the APIs we call)
- Prefer optional chaining (`?.`) over non-null assertions (`!`)
