<!--
Thanks for the PR! A few notes before you hit submit:
- For security-sensitive changes, please review SECURITY.md first.
- New customer data sources MUST route through src/pii-scrubber.ts before any text leaves the process.
-->

## Summary

<!-- What does this change and why? 1-3 bullets. -->

## Type of change

- [ ] Bug fix
- [ ] New feature
- [ ] Refactor
- [ ] Docs
- [ ] Security / dependency update

## Checklist

- [ ] `npm run build` passes locally
- [ ] `npm test` passes locally
- [ ] `npm run audit:ci` shows no high/critical advisories
- [ ] PII scrubbing is preserved on any new data source
- [ ] CHANGELOG.md updated under `[Unreleased]` (for user-visible changes)
- [ ] No credentials, customer data, or `.env` contents in the diff or description

## Linked issues

<!-- Closes #123, refs #456 -->
