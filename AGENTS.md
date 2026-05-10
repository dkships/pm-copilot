# PM Copilot — Agent Instructions

Guidance for AI coding agents (Claude Code, Codex, Cursor, Aider, etc.) working in this repo. Human contributors: see [CONTRIBUTING.md](CONTRIBUTING.md).

## What this is

MCP server connecting an LLM to customer signal data (HelpScout support tickets + ProductLift feature requests). Cross-source theme analysis and prioritized product planning.

## Tech stack

- TypeScript, ES modules, Node 18+
- `@modelcontextprotocol/sdk` with stdio transport
- HelpScout API v2 (OAuth2 client credentials)
- ProductLift API v1 (Bearer token, multi-portal)

## Scope and boundaries

- PII scrubbing on all customer text before analysis (SSN, CC, email, phone). See [SECURITY.md](SECURITY.md).
- Never send unscrubbed customer text. Scrubbing happens at the format layer.
- Return raw structured data from tools. Let the LLM do synthesis.
- Partial-failure resilient: if one API is down, return data from the other plus a warnings array.

## Working rules

- Use `registerTool` / `registerResource` for MCP registration (not deprecated `.tool()`)
- All API clients in their own module (e.g., `helpscout.ts`, `productlift.ts`)
- Handle errors with `isError: true` responses
- No `any` types. Use `as T` casts at API boundaries.
- Theme config loaded at runtime via `fs.readFileSync` — edits don't require rebuild
- Use environment variables for credentials. Never paste token values into config or commit them.
- Run `npm run build` after source changes before testing through an MCP client.

## Definition of done

- Tool responses include `pii_scrubbing_applied: true` and `pii_categories_redacted`
- Partial failures return a `warnings` array identifying which source failed
- `npm run build`, `npm test`, and `npm run audit:ci` all pass
- New customer data sources route through `src/pii-scrubber.ts`
