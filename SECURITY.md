# Security Policy

## Supported versions

Only the latest `1.x` release receives security fixes. Older releases are not patched.

| Version | Supported |
| ------- | --------- |
| 1.x     | Yes       |
| < 1.0   | No        |

## Reporting a vulnerability

Please report security issues privately to **security@dmkthinks.org** (or open a [GitHub security advisory](https://github.com/dkships/pm-copilot/security/advisories/new) if you have access). Do not open a public issue for security reports.

Expected response: acknowledgement within 5 business days. If the report is valid, a fix targets release within 30 days. We will credit reporters in the changelog unless asked otherwise.

## What's in scope

- The MCP server itself (`src/`, `dist/`)
- The PII scrubbing pipeline (`src/pii-scrubber.ts`)
- HelpScout, ProductLift and Chatbase API clients (`src/helpscout.ts`, `src/productlift.ts`, `src/chatbase.ts`)
- Dependency supply chain (`package-lock.json`)

## What's out of scope

- Issues in upstream dependencies — report those to the upstream project. We monitor `npm audit` and patch transitive vulns on release.
- Misconfigured deployments (e.g., committing your own `.env`). The repo ships `.gitignore` rules for the obvious files; you are responsible for not bypassing them.
- Vulnerabilities that require an attacker to already control your local machine or your HelpScout / ProductLift / Chatbase credentials.

## PII handling

The server scrubs PII at the format layer before any customer text leaves the process. Categories scrubbed: SSN (US format), credit cards (Luhn-validated), email addresses, phone numbers (US formats, plus `+`-prefixed international numbers). Customer email fields are always replaced with `[REDACTED]` regardless of pattern match.

Known limitations of the current scrubber:

- Regexes are US-centric. International numbers without a `+` prefix (e.g. a UK `07700 900123`) and non-US national ID formats are not redacted.
- Feature-request URLs are scrubbed, but slugs usually strip `@` and `.`, so an email in a title can survive in the URL in a mangled form (`johngmailcom`). Digits survive slugification and are caught.
- Names and street addresses in message text are not redacted (high false-positive rate). ProductLift commenter names are dropped at the format layer instead.
- Patterns are deliberately greedy: long digit runs such as order numbers, tracking IDs, and timestamps can be redacted as phone/SSN false positives. Over-redaction is preferred to leakage, so expect some non-PII numbers to be masked in analysis text.
- The `kpi_context` tool parameter is passed verbatim. Callers are responsible for not pasting raw PII into that field.
- Excluded data is listed below. See also the [README security section](README.md#security).

## What's excluded entirely

These are never fetched, or are dropped at the format layer before analysis:

| Data | Why |
|------|-----|
| Agent/admin responses | Only customer voice matters; agent replies could leak internal process |
| Internal HelpScout notes | May contain credentials, workarounds, internal discussions |
| Attachments | Could contain screenshots with PII, invoices, medical documents |
| Voter identities | Vote counts are enough; individual identity adds no PM value |
| Commenter names and emails | The role (admin vs customer) is all the analysis needs |
| Chatbase assistant turns | Only the customer's own words are analysed |
| Chatbase lead form submissions | Captured names, emails and phone numbers, with no PM value |
| Chatbase end-user identifiers | `userId` narrows identity across conversations |
| Chatbase per-conversation country | Geo adds nothing to theme analysis and narrows identity |

### Chat as a data source

A chat widget takes unbounded free text, so Chatbase is the widest PII surface of the three sources. People paste order numbers, addresses and licence keys into a chat box in a way they don't into a roadmap post. On a live 30-day run, adding Chatbase was what first made `credit_card` appear in `pii_categories_redacted`; tickets and roadmap posts over the same window produced only emails and phone numbers.

Two things keep it contained: only `role: "user"` turns are read, and every turn goes through the same scrubber as the other sources. Because `role` is explicit, Chatbase is also the cleanest customer-voice source. The HelpScout path has to guess at agent text with phrase heuristics, since a conversation preview may be either side of the exchange.

## Audit controls

- `preview_only: true` on `generate_product_plan` shows what data would be sent without fetching it.
- Every response includes `pii_scrubbing_applied` and `pii_categories_redacted`.
- Data categories are logged to stderr on each call (categories only, never content).

If you find a way to bypass scrubbing on supported categories, that's a vulnerability — please report it.

## Hardening notes for operators

- Treat `.env` as a credential file. Do not commit it. Do not paste its contents into chat logs or issue trackers.
- Use a HelpScout OAuth app scoped to read-only conversation access.
- Use a ProductLift API key scoped to the portals you actually need.
- `CHATBASE_API_KEY` is account-wide, so treat it as access to every agent on the account.
- The server only speaks stdio (`StdioServerTransport`); it does not bind a network port. If you wrap it in a network-exposed transport, you are responsible for authentication.
