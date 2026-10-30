# Healthcare dispatch demo

**200 synthetic tickets modeled on healthcare dispatch support; real pm-copilot methodology.**
The ticket mix was set to mirror the case brief (crashing calendar, double-bookings, 14-click reassignment), so the ranking shows the method working, not a discovery.
pm-copilot does the deterministic scoring so results are reproducible; Claude, connected through MCP, writes the synthesis.

## Themes by priority score

| # | Theme | Tickets | Severity | Convergence | Priority |
|---|-------|--------:|---------:|:-----------:|---------:|
| 1 | Calendar crashes, freezes & won't load | 61 | 68.4 | No | **58.9** |
| 2 | Double-booked trips & shifts | 45 | 62.3 | No | **47.6** |
| 3 | Driver app sync & status lag | 25 | 56.6 | No | **34.1** |
| 4 | Driver reassignment is slow / too many clicks | 32 | 37.4 | No | 31.4 |
| 5 | Facility notifications & ETAs | 18 | 42.5 | No | 25.2 |
| 6 | Reporting, billing exports & trip logs | 16 | 37.5 | No | 22.3 |
| 7 | Permissions, logins & user access | 10 | 34.1 | No | 17.7 |
| 8 | Automation, AI dispatch & auto-assign | 10 | 27.0 | No | 15.2 |

<sub>Two-problem tickets count under both themes. Convergence needs feature-request votes; this demo has tickets only.</sub>

## Insights you can act on

<sub>Synthesis by Claude over pm-copilot output. Problems are paraphrased from the dispatcher's side; counts come from <a href="scripts/count-patterns.mjs"><code>count-patterns.mjs</code></a> and can overlap.</sub>

**1. Calendar.** **Problem:** the board dies at peak and I dispatch from paper. **Evidence:** 61 tickets; 15 fell back to paper, phone or radio; 10 cite the Monday standing-order load; 9 early morning. ***Hypothesis:*** the board draws every leg at once. **Next → metric:** trace Monday 5–7am loads → 5–7am freeze rate.

**2. Double-booking.** **Problem:** it puts one van on two trips without a warning. **Evidence:** 45 tickets; 13 say nothing warned them; 9 import or standing-order duplicates; 7 two people booking one trip. ***Hypothesis:*** an overlap check at save plus import de-dup covers most. **Next → metric:** overridable overlap warning → overlaps per 1,000 trips.

**3. Driver app.** **Problem:** I change a manifest and the driver never sees it. **Evidence:** 25 tickets; 7 changes never arrived; 4 status stuck; 3 location lag. ***Hypothesis:*** mid-run edits wait for an app restart. **Next → metric:** log manifest delivery acks → share acked within 60 s.

**Automation.** **Problem:** I want driver suggestions I can approve. **Evidence:** 10 tickets; 8 ask it to propose or auto-assign a driver; 4 want approval; 2 name the call-off; of 4 that say "AI", 3 mean this and 1 says fix the calendar first. ***Hypothesis:*** "AI dispatch" means suggestions, not autonomy. **Next → metric:** test suggested moves on call-off mornings → acceptance rate.

**So what.** Fix the calendar at peak first, then add the overlap warning.\
The AI ask is "propose a driver, I approve" (8 of 10); call-offs are when it's needed (13 of 32 reassignment tickets, 2 automation tickets), which is what the [prototype](https://dispatch-prototype-mocha.vercel.app) tests.

**PII:** 11 emails and 12 phone numbers redacted from 20 tickets; customer email fields always masked. **AI vs. reliability:** 5% of tickets (10 of 200) explicitly ask for automation or AI dispatch; 30.5% (61 of 200) are about calendar reliability.

<details>
<summary>How this was made, and how accurate the theme matching is</summary>

**Precision and recall** against each ticket's ground-truth `syntheticTheme` label, from [`check-coverage.mjs`](scripts/check-coverage.mjs). 44 tickets carry a second label; on reading, 19 genuinely raise both problems, and only those 19 count toward their second theme. *Strict* counts the primary label only.

| Theme | Matched | Precision | Strict | Recall |
|---|--:|--:|--:|--:|
| Calendar crashes | 61 | 100% | 98% | 100% |
| Double-booking | 45 | 96% | 89% | 100% |
| Reassignment | 32 | 97% | 94% | 100% |
| Driver app sync | 25 | 92% | 76% | 95% |
| Notifications & ETAs | 18 | 94% | 89% | 100% |
| Reporting & billing | 16 | 100% | 88% | 100% |
| User access | 10 | 100% | 100% | 100% |
| Automation | 10 | 100% | 100% | 100% |

Coverage is 199/200 (99.5%), but keywords were tuned on these tickets, so treat every number here as in-sample.

**Human check.** Mirrors the write-up's "hand-check 20 tickets" step. The `syntheticTheme` label stands in for the reviewer; pm-copilot's pick is the matched theme with the most keyword hits. The sample is seeded and stratified by pm-copilot's pick, so every category gets checked; an unstratified draw with the same seed landed 14 of 20 on calendar. **Agreement: 17/20 (85%).** Two of the three disagreements are genuine two-problem tickets where pm-copilot picked the other theme.

| | pm-copilot | Reviewer | Ticket |
|---|---|---|---|
| ✓ | user access | user access | Our supervisors can't edit trips |
| ✓ | calendar | calendar | calendar unresponsive when filtering twice |
| ✓ | calendar | calendar | Calendar crashes every time we book a same-day discharge |
| ✓ | calendar | calendar | filter by vehicle crashes the board |
| ✓ | calendar | calendar | Facility portal calendar loses our bookings on crash |
| ✓ | calendar | calendar | Month view crashes on first of the month |
| ✗ | notifications | automation | suggested driver |
| ✓ | notifications | notifications | Facility got three driver assigned texts for one transfer |
| ✗ | reassignment | automation | auto reassign when a crew calls off *(raises both)* |
| ✓ | reassignment | reassignment | Call-off at 6am took 20 minutes to move one manifest |
| ✓ | reassignment | reassignment | Reassign flow, 12 clicks per trip |
| ✓ | reporting | reporting | Utilization report times out |
| ✓ | reporting | reporting | Level of service column says ambulatory for everything |
| ✗ | driver app | reporting | Trip log has no pickup or drop-off times for a chunk of trips *(raises both)* |
| ✓ | driver app | driver app | Cancelled trip still showing, trip 51907 |
| ✓ | automation | automation | Interfacility transfers: auto-assign nearest unit |
| ✓ | double-booking | double-booking | overtime from double scheduled driver |
| ✓ | double-booking | double-booking | scheduler lets me double book vehicles |
| ✓ | double-booking | double-booking | is the ride booked twice? |
| ✓ | double-booking | double-booking | same ride booked by two people on our team |

**Other notes.**

- Tickets: [`tickets.healthcare-dispatch.json`](tickets.healthcare-dispatch.json), all tagged `synthetic`, with wording grounded in [`research.md`](research.md). No real customers or patients.
- Severity is 0–100: thread depth, recency and bug/urgent/escalation tags. The ticket text came first; the generator then added thread counts and bug/urgent/escalation tags with per-theme odds I chose. Outages and double-bookings get more of them than UX friction, so the severity column reflects those choices.
- Representative quotes prefer tickets that match only that theme, so a ticket that raises two problems doesn't headline either one.
- Themes: [`themes.healthcare-dispatch.json`](themes.healthcare-dispatch.json). Output: [`output/synthesize.json`](output/synthesize.json) and [`output/product-plan.md`](output/product-plan.md), from a build with no `.env`, so no live data mixed in.
- Reproduce:

  ```bash
  npm run build
  export PM_COPILOT_FIXTURE_TICKETS="$PWD/demo/tickets.healthcare-dispatch.json"
  export PM_COPILOT_THEMES_PATH="$PWD/demo/themes.healthcare-dispatch.json"
  npm run tool -- synthesize_feedback '{"timeframe_days":30,"detail_level":"standard"}'
  node demo/scripts/check-coverage.mjs   # precision, recall, confusion, human check
  node demo/scripts/count-patterns.mjs   # the counts behind the insights
  ```

  A `.env` with ProductLift or Chatbase credentials adds that live data to the run. Tickets are dated 2026-10-01 to 2026-10-30; run `node demo/scripts/build-tickets.mjs` to move the dates forward before recording.

</details>
