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

## Code style

Adapted from Fabien Sanglard's agent.md (2026-08-21).

- Avoid magic numbers and strings. Extract recurring or meaningful values into named constants or enums; leave self-explanatory one-off values inline. A value defined by a spec (HTTP 200, a protocol byte) gets a constant regardless.
- Reduce indentation. Use early returns and `continue` instead of nesting.
- Keep function names under 30 characters.
- Use an enum or a string-literal union instead of a boolean parameter.
- Put blank lines between logical blocks. Let the reader breathe.
- Comment what a block does and why, briefly. Use an example where it helps; offer an ASCII diagram when explaining a whole system.
- Treat a visibility change as a breaking design shift. Keep things private or unexported unless the design requires external access, and ask before widening one.
- Program to levels of abstraction. Low-level mechanics (raw SQL, socket streams, vendor SDK calls, file parsing) live behind a driver or service layer; callers work in domain concepts.
- Hold the layer boundaries. Each layer talks only to the one directly below it, with no holes punched through: a UI component never calls the database or a raw HTTP client directly.
- Don't touch code unrelated to the feature you're implementing, including adding comments to blocks you didn't write. Minimize changed lines.
- Always use braces, even on a one-line `if`.
- Fixing a bug: write the failing test first, watch it fail, then write the fix and watch it pass.

### Commit messages

- Imperative mood, capitalized subject, no trailing period. Test: "If applied, this commit will <subject>".
- Keep the subject under 72 characters. Blank line before the body.
- The body explains what and why, not how; the code shows the how. Wrap it at 72 characters.
