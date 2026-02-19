/**
 * PM Copilot Product Planning Methodology
 *
 * Encoded framework for how to interpret customer signal data and build
 * a prioritized product plan. Exposed as an MCP resource so Claude can
 * reference it when using generate_product_plan.
 */

export const METHODOLOGY_VERSION = "2.0";

export const METHODOLOGY_CONTENT = `# David Kelly's Product Planning Framework v${METHODOLOGY_VERSION}

This is how I decide what to build across AppSumo Originals products (TidyCal, BreezeDoc, FormRobin). I've developed this over 7+ years of launching 9 products to 1M+ users. This is what PM Copilot references when generating product plans — not a generic PM textbook.

## The 5% Rule

Every month, we get 200+ pieces of feedback from users, prospects, and customers. We have a 10-person team. We complete only about 5% of what customers ask for each month. That means the other 95% gets deliberately ignored — not because it's bad feedback, but because focus is what got us to $13M+ in revenue on a bootstrapped budget.

The most important thing is to keep the most important thing the most important thing. This framework exists to identify which 5% matters most.

## Cream Rises to the Top: Convergent Signals

The single most important signal is when the same theme shows up independently in two places: support tickets (people hitting real problems) AND feature requests (people asking for something new). I call these convergent signals, and they always win.

Why? They've been validated by two completely different customer behaviors. A support ticket means someone is frustrated enough to write in. A feature request means someone cares enough to find our roadmap page and vote. When both happen for the same theme, that's not noise — that's the product telling you something.

Convergent themes get a 2x priority boost. In practice, convergent themes have been the ones that actually move retention numbers when we fix them.

## Two Kinds of Signals, Weighted Differently

### Reactive signals (support tickets)
People hitting real pain right now. I weight these heavier than feature requests because broken stuff drives churn. You can survive not having a feature; you can't survive your booking page throwing errors.

Severity indicators I track:
- Thread count: 5+ back-and-forth messages means the issue is complex or genuinely confusing. Either way, needs fixing.
- Recency: A spike in the last 7 days matters way more than a steady trickle over 90 days. Spikes mean something broke. I use a 7-day half-life decay so recent pain dominates.
- Tags: "escalation", "critical", "urgent", "bug" — these are the support team telling me normal workflow couldn't handle it.

### Proactive signals (feature requests + votes)
People telling you what they want. Vote counts measure breadth (how many care?) and comments measure depth (how much do they care?). I weight votes at 80% and comments at 20%.

Critical distinction: High votes with zero support tickets means it's a WANT, not a NEED. Dark mode with 50 votes but zero display tickets? Nice-to-have territory.

## The Scoring Formula

\`\`\`
priority = (frequency × 0.35 + severity × 0.35 + vote_momentum × 0.30)
           × convergence_boost
\`\`\`

- Frequency (35%): How many people are affected. Table stakes.
- Severity (35%): How bad it is. 5 people who can't log in matters more than 50 who want a font change.
- Vote momentum (30%): Slightly lower because votes skew toward power users who find roadmap pages.
- Convergence (2x): When a theme appears in both sources, the entire score doubles. Strongest lever in the system.

## When Business Metrics Change Everything

The formula gives customer signal priorities. When I have Metabase, GA, or revenue data, I adjust:

Churn data overrides the formula. If TidyCal churn spikes from 3% to 4%, I immediately look at reactive signals. Booking completion dropping? That's the priority regardless of score.

Revenue per theme matters. Billing issues in a $2M ARR product get more attention than the same score in a $200K product. I apply this as judgment, not formula.

Usage validates demand. High votes but low usage on the related existing feature? I discount it. People vote for what sounds good, not necessarily what they'll use.

Growth data sets the posture. Organic traffic up 22% MoM? Lean into proactive features that attract new users. Growth flat? Focus on reactive fixes to stop the bleeding.

## Quick Wins Punch Above Their Weight

A small fix that reduces ticket volume by 20% is often more valuable than a big feature that takes 3 months. Why:
1. Frees the support team immediately
2. Improves the experience for hundreds of users this week
3. Gives the dev team a win while bigger initiatives are planned

With our team (one designer, two backend devs), I ship 5-15 focused projects per product per month rather than chase one ambitious feature for a quarter. The scope increases to the length of time given — monthly cadence keeps us honest.

We target 80%+ on-time completion, not 100%. That wiggle room handles surprise bugs, projects with lower-than-expected ROI we cancel mid-month, and the occasional project that deserves extra polish.

## When I Override the Data

The formula is a starting point, not the answer. I override when:

Customer segment knowledge: Our AppSumo lifetime deal buyers behave differently than monthly subscribers. LTD users care about licensing, account access, "will this product survive?" Monthly users care about the product working day-to-day. The data doesn't segment this way, so I apply judgment.

Signal before spend: Sometimes I know we need to build something not because the data says so, but because it's how we win a market. But I always test cheap first — wait for signal before committing real resources. I've killed products with $1M+ invested when the signal wasn't there. Sunk cost can't drive prioritization.

Customer proximity: I still call 2-4 TidyCal customers per month, even at 350K+ users. Phone calls surface nuance that tickets and votes miss — tone, workarounds people have built, adjacent problems they don't think to report. When my calls contradict the data, I dig deeper before trusting either source.

Competitive pressure: If a competitor just shipped something our customers are asking about, urgency changes regardless of the formula.

Team energy: If the dev team is burned out on bug fixes, I'll slot in a feature build. Sustained output matters more than perfect prioritization.

## What This Framework Does NOT Do

Honest about the limits:
- It tells you WHAT to prioritize, not HOW to build it
- It can't detect problems customers don't report (silent churn)
- It skews toward English-speaking, vocal customers
- Revenue impact is still my judgment, not calculated
- It won't catch emerging categories until enough signals accumulate
- The weights (0.35/0.35/0.30) are calibrated for our products — other products might need different ratios
- It processes the signal, but the final call is still mine

## The Monthly Cadence

Goal → KPIs → Levers. Keep it simple: one clear goal, a few KPIs that indicate progress, and controllable levers the team can pull.

Every month: pull the signals, run the analysis, overlay business metrics, apply judgment, ship 5-15 things per product. Review what moved the needle. Adjust themes if the world changed.

The tool does the signal processing. The judgment is still mine.
`;
