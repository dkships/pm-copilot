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
- HelpScout and ProductLift API clients (`src/helpscout.ts`, `src/productlift.ts`)
- npm package supply chain (`package.json`, `package-lock.json`)

## What's out of scope

- Issues in upstream dependencies — report those to the upstream project. We monitor `npm audit` and patch transitive vulns on release.
- Misconfigured deployments (e.g., committing your own `.env`). The repo ships `.gitignore` rules for the obvious files; you are responsible for not bypassing them.
- Vulnerabilities that require an attacker to already control your local machine or your HelpScout / ProductLift credentials.

## PII handling

The server scrubs PII at the format layer before any customer text leaves the process. Categories scrubbed: SSN (US format), credit cards (Luhn-validated), email addresses, phone numbers (US format). Customer email fields are always replaced with `[REDACTED]` regardless of pattern match.

Known limitations of the current scrubber:

- Regexes are US-centric. International phone numbers and non-US national ID formats are not redacted.
- Names and street addresses are not redacted (high false-positive rate).
- The `kpi_context` tool parameter is passed verbatim. Callers are responsible for not pasting raw PII into that field.
- Agent responses, internal HelpScout notes, attachments, voter identities, and commenter emails are excluded from fetches by design (see README "Security & PII" section).

If you find a way to bypass scrubbing on supported categories, that's a vulnerability — please report it.

## Hardening notes for operators

- Treat `.env` as a credential file. Do not commit it. Do not paste its contents into chat logs or issue trackers.
- Use a HelpScout OAuth app scoped to read-only conversation access.
- Use a ProductLift API key scoped to the portals you actually need.
- The server only speaks stdio (`StdioServerTransport`); it does not bind a network port. If you wrap it in a network-exposed transport, you are responsible for authentication.
