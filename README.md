# PM Copilot

An MCP server that triangulates customer signals across support tickets and feature requests to generate prioritized product plans.

## What it does

Product managers drown in fragmented customer data. Support tickets show what's broken. Feature request boards show what's wanted. But the highest-confidence signal is when the same theme appears in *both* places independently — a customer writing in about calendar sync problems while others are voting for calendar integrations on your roadmap. PM Copilot finds those convergent signals automatically.

The server connects to HelpScout (support tickets) and ProductLift (feature requests), normalizes them into a common format, matches them against configurable themes, and scores each theme using a weighted formula that gives convergent signals a 2x priority boost. The output is structured data that Claude synthesizes into actionable product plans — complete with evidence counts, customer quotes, and severity breakdowns.

## Tools

### `synthesize_feedback`

Cross-references both data sources and returns theme-matched analysis with priority scores.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `timeframe_days` | number | 30 | Days to look back (1-90) |
| `top_voted_limit` | number | 50 | Max feature requests by vote count |
| `mailbox_id` | string | — | HelpScout mailbox filter |
| `portal_name` | string | — | ProductLift portal filter |

Returns themes sorted by priority score, each with reactive/proactive counts, convergence flag, and matched data points.

### `generate_product_plan`

Builds a prioritized product plan with evidence summaries and customer quotes. This is the composability entry point — it accepts external business metrics alongside feedback data.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `timeframe_days` | number | 30 | Days to look back (1-90) |
| `top_voted_limit` | number | 50 | Max feature requests by vote count |
| `mailbox_id` | string | — | HelpScout mailbox filter |
| `portal_name` | string | — | ProductLift portal filter |
| `kpi_context` | string | — | Business metrics from other MCP servers |
| `max_priorities` | number | 5 | Number of priorities to return (1-10) |
| `preview_only` | boolean | false | Audit mode: show what data *would* be sent |

Each priority in the response includes: theme name, signal type (reactive/proactive/convergent), priority score, evidence breakdown, and 2-3 representative customer quotes.

### `get_feature_requests`

Raw ProductLift data access for browsing feature requests directly.

## Resources

### `pm-copilot://methodology`

A structured product planning framework that Claude references when generating plans. Covers signal weighting rules, convergent signal logic, how to balance reactive vs proactive priorities, revenue vs user satisfaction trade-offs, and common PM anti-patterns to avoid.

The methodology is versioned and served as markdown content via the MCP resource protocol.

## Composability

PM Copilot is designed to work alongside other MCP servers. The `kpi_context` parameter on `generate_product_plan` is the integration point.

When Claude has multiple MCP servers connected — say Metabase for database queries and Google Analytics for traffic data — a PM can make a single request:

> "Pull our churn data from Metabase, our traffic trends from GA, and then use pm-copilot to create a product plan using all of that context."

Claude calls the Metabase and GA servers first, then passes their output as `kpi_context` to `generate_product_plan`. The methodology resource tells Claude how to weight business metrics against customer signals: rising churn elevates reactive themes, strong growth elevates proactive ones.

This works because MCP servers don't need to know about each other. Claude is the orchestrator. PM Copilot just needs to accept free-text context and return structured analysis. No point-to-point integrations required.

## Quick start

```bash
# Clone and install
git clone https://github.com/yourusername/pm-copilot.git
cd pm-copilot
npm install

# Configure credentials
cp .env.example .env
# Edit .env with your HelpScout and ProductLift credentials

# Build
npm run build
```

### Add to Claude Desktop

Add to your Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "pm-copilot": {
      "command": "node",
      "args": ["/absolute/path/to/pm-copilot/dist/index.js"]
    }
  }
}
```

### Add to Claude Code

```bash
claude mcp add pm-copilot -- node /absolute/path/to/pm-copilot/dist/index.js
```

## Configuration

### Environment variables

Create a `.env` file in the project root:

```bash
# Required: HelpScout OAuth2 credentials
# Create app at https://secure.helpscout.net/apps/custom/
HELPSCOUT_APP_ID=your_app_id
HELPSCOUT_APP_SECRET=your_app_secret

# Optional: ProductLift feature request portals
# Option A: Multiple portals
PRODUCTLIFT_PORTALS=tidycal|https://roadmap.tidycal.com|your_key,formrobin|https://roadmap.formrobin.com|your_key

# Option B: Single portal
PRODUCTLIFT_PORTAL_NAME=tidycal
PRODUCTLIFT_PORTAL_URL=https://roadmap.tidycal.com
PRODUCTLIFT_API_KEY=your_key
```

HelpScout credentials are required. ProductLift is optional — without it, analysis runs on support data only (no convergence detection).

### Theme configuration

`themes.config.json` in the project root defines what themes to look for. Edit it without rebuilding — the file is loaded at runtime.

```json
{
  "version": 1,
  "themes": [
    {
      "id": "calendar-sync",
      "label": "Calendar Sync",
      "keywords": ["calendar sync", "google calendar", "outlook calendar", "ical"],
      "category": "integration"
    }
  ],
  "stop_words": ["the", "a", "is", ...],
  "emerging_theme_min_frequency": 3
}
```

Ships with 8 seed themes: calendar-sync, dark-mode, api-webhooks, mobile-app, billing-payment, login-auth, performance, notifications. Add your own by appending to the `themes` array.

Data points that don't match any known theme are analyzed for emerging patterns using bigram/trigram frequency detection.

## Data privacy

Customer data flows through PM Copilot on its way to Claude. This section documents what gets sent, what gets scrubbed, and what gets excluded entirely.

### PII scrubbing

All customer text is scrubbed before it enters the analysis pipeline or leaves the server:

- **SSNs**: Pattern-matched and replaced with `[SSN REDACTED]`
- **Credit card numbers**: Matched with Luhn algorithm validation to reduce false positives
- **Email addresses**: Pattern-matched and replaced with `[EMAIL REDACTED]`
- **Phone numbers**: US format patterns replaced with `[PHONE REDACTED]`
- **Customer email field**: Always `[REDACTED]`, regardless of pattern matching

### What we decided not to send

| Data | Why it's excluded |
|------|-------------------|
| Customer email addresses | Not needed for theme analysis; PII risk outweighs utility |
| Agent/admin responses | Only customer voice matters for signal analysis; agent replies could leak internal process |
| Internal HelpScout notes | May contain credentials, workarounds, internal discussions |
| Attachments | Could contain screenshots with PII, invoices, medical documents |
| Voter identities | Vote counts are sufficient; individual identity adds no PM value |

### Audit controls

- **Preview mode**: Set `preview_only: true` on `generate_product_plan` to see exactly what data would be fetched and sent — without actually fetching it
- **Response metadata**: Every tool response includes `pii_scrubbing_applied` and `pii_categories_redacted`
- **Stderr logging**: Each call logs data categories sent (e.g., "helpscout_tickets", "productlift_votes") but never content

### What this does not cover

Names in free text (too many false positives to regex reliably), physical addresses (same), and domain-specific identifiers like order IDs (useful for PM analysis, not regulated PII). The `kpi_context` parameter passes through verbatim — the caller is responsible for that content.

## Architecture

```
src/
  index.ts              # MCP server, tool registration, shared fetch pipeline
  helpscout.ts          # HelpScout API v2 client (OAuth2 client credentials)
  productlift.ts        # ProductLift API v1 client (Bearer token, multi-portal)
  feedback-analyzer.ts  # Theme matching, scoring engine, emerging theme detection
  pii-scrubber.ts       # PII pattern detection and redaction
  methodology.ts        # PM planning framework (MCP resource)
themes.config.json      # Human-editable theme definitions + keywords
```

**Scoring formula**: `priority = (frequency * 0.35 + severity * 0.35 + vote_momentum * 0.30) * convergence_boost`

- **Frequency** (0.35): Count of matching data points, normalized across themes
- **Severity** (0.35): Reactive signals only — thread depth, recency (exponential decay), tag boosts for bug/urgent/escalation
- **Vote momentum** (0.30): Proactive signals only — 80% votes + 20% comments
- **Convergence boost** (2x): Applied when a theme has both reactive and proactive signals

Error handling uses `Promise.allSettled` — if one API is down, analysis continues with data from the other source. All HTTP requests have 30-second timeouts. Auth failures produce specific error messages referencing the relevant `.env` variable.

## Built with

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) — built the entire codebase through iterative conversation
- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) (`@modelcontextprotocol/sdk`)
- TypeScript, Node.js 18+
- [Zod](https://github.com/colinhacks/zod) for input validation
- No ML dependencies — theme matching is keyword-based, emerging themes use n-gram frequency analysis

## Future directions

**v2: MCP App with interactive priority dashboard**
Return structured UI components instead of raw JSON. An MCP App could render a priority matrix, let PMs drag-and-drop to reorder, and annotate themes with strategic notes — all within the Claude interface.

**PM methodology as an Agent Skill**
Package the product planning framework as a standalone skill that any Claude agent can use, independent of PM Copilot's data sources. Teams could apply the same prioritization methodology to their own data pipelines.

**Automated weekly product review**
A scheduled workflow that runs `generate_product_plan` weekly, compares against the previous week's priorities, and posts a diff to Slack or Linear — surfacing what changed, what's trending up, and what dropped off.

## Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/your-feature`)
3. Make your changes and ensure `npm run build` succeeds with no errors
4. Follow existing patterns: tools use `registerTool`, API clients get their own module, PII scrubbing happens at the format layer
5. Open a pull request

When adding a new data source, create a new client module (e.g., `src/intercom.ts`) and integrate it into `fetchAndAnalyze()` in `index.ts` using the same `Promise.allSettled` pattern for partial failure resilience.

## License

MIT
