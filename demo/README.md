# Healthcare dispatch demo

**200 synthetic tickets modeled on healthcare dispatch support; real pm-copilot methodology.**

## Themes by priority score

| # | Theme | Tickets | Severity | Convergence | Priority |
|---|-------|--------:|---------:|:-----------:|---------:|
| 1 | Calendar crashes, freezes & won't load | 64 | 67.4 | No | **58.6** |
| 2 | Double-booked trips & shifts | 46 | 61.3 | No | **46.6** |
| 3 | Driver reassignment is slow / too many clicks | 39 | 43.0 | No | **36.4** |
| 4 | Driver app sync & status lag | 26 | 56.1 | No | 33.8 |
| 5 | Reporting, billing exports & trip logs | 24 | 44.1 | No | 28.6 |
| 6 | Facility notifications & ETAs | 23 | 42.2 | No | 27.3 |
| 7 | Permissions, logins & user access | 12 | 37.1 | No | 19.5 |
| 8 | Automation, AI dispatch & auto-assign | 10 | 27.0 | No | 14.9 |

<sub>A ticket that raises two problems counts under both themes. Severity is 0–100 (thread depth, recency, bug/urgent/escalation tags). Convergence needs feature-request votes as well as tickets; this demo has tickets only.</sub>

## Top 3 priorities

1. **Calendar reliability**: *"Between 6 and 7 in the morning, when the night crew hands off to day, the calendar freezes constantly. That's the busiest hour for transports we have."*
2. **Double-booking**: *"Our broker sent a late-pickup notice on a trip we never meant to run. Turns out their file import created the trip twice…"*
3. **Reassignment friction**: *"When a driver calls off we reassign trip by trip. There is no way to select the whole manifest or even a block of the morning and send it to one driver."*

**PII scrubbing:** 11 email addresses and 12 phone numbers were redacted from 20 tickets before analysis, and every customer email field was masked.

**AI vs. reliability:** 5% of tickets (10 of 200) explicitly ask for automation or AI dispatch; 32% (64 of 200) are about calendar reliability.

<details>
<summary>How this was made</summary>

- Tickets: [`tickets.healthcare-dispatch.json`](tickets.healthcare-dispatch.json), all tagged `synthetic`, with wording grounded in [`research.md`](research.md). No real customers or patients.
- Themes: [`themes.healthcare-dispatch.json`](themes.healthcare-dispatch.json). Coverage is 198/200 (99%), but keywords were tuned on these tickets, so treat that as in-sample.
- Output: [`output/synthesize.json`](output/synthesize.json) and [`output/product-plan.md`](output/product-plan.md), from a build with no `.env`, so no live data mixed in.
- Reproduce:

  ```bash
  npm run build
  export PM_COPILOT_FIXTURE_TICKETS="$PWD/demo/tickets.healthcare-dispatch.json"
  export PM_COPILOT_THEMES_PATH="$PWD/demo/themes.healthcare-dispatch.json"
  npm run tool -- synthesize_feedback '{"timeframe_days":30,"detail_level":"standard"}'
  node demo/scripts/check-coverage.mjs   # coverage, recall, redaction counts
  ```

  A `.env` with ProductLift or Chatbase credentials adds that live data to the run. Tickets are dated 2026-10-01 to 2026-10-30; run `node demo/scripts/build-tickets.mjs` to move the dates forward before recording.

</details>
