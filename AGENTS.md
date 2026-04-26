# PM Copilot — Agent Instructions

## What This Is
MCP server connecting Claude to customer signal data (HelpScout support tickets + ProductLift feature requests). Cross-source theme analysis and prioritized product planning.

## Tech Stack
- TypeScript, ES modules, Node 18+
- `@modelcontextprotocol/sdk` with stdio transport
- HelpScout API v2 (OAuth2 client credentials)
- ProductLift API v1 (Bearer token, multi-portal)

## Scope And Boundaries
- PII scrubbing on all customer text before analysis (SSN, CC, email, phone)
- Never send unscrubbed customer text — scrubbing happens at the format layer
- Return raw structured data from tools — let the LLM do synthesis
- Partial failure resilient: one API down returns data from the other + warnings

## Working Rules
- Use `registerTool` / `registerResource` for MCP registration (not deprecated `.tool()`)
- All API clients in their own module (e.g., `helpscout.ts`, `productlift.ts`)
- Handle errors with `isError: true` responses
- No `any` types — use `as T` casts for API responses
- Theme config loaded at runtime via `fs.readFileSync` — edits don't require rebuild
- The global Codex config has a disabled `pm-copilot` MCP template pointing at `dist/index.js`; run `npm run build` after source changes before testing through Codex MCP.
- Use `env_vars` or inherited shell env for credentials; never copy token values into config.

## Hallucination Prevention
See `~/.agents/AGENTS.md`. For this MCP server: sources = code and HelpScout/ProductLift API responses.

## Definition Of Done
- Tool responses include `pii_scrubbing_applied: true` and `pii_categories_redacted`
- Partial failures return warnings array identifying which source failed
- Changes compile and pass manual testing via MCP client

## Maintenance
- Owner: David Kelly
- Last Updated: 2026-04-26
