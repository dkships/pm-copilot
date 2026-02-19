/**
 * PM Copilot Product Planning Methodology
 *
 * Encoded framework for how to interpret customer signal data and build
 * a prioritized product plan. Exposed as an MCP resource so Claude can
 * reference it when using generate_product_plan.
 */

export const METHODOLOGY_VERSION = "1.0";

export const METHODOLOGY_CONTENT = `# PM Copilot — Product Planning Methodology v${METHODOLOGY_VERSION}

## Signal Types

### Reactive Signals (HelpScout support tickets)
- Customers hitting real problems right now
- High severity = they took time to write in
- Thread count is a severity proxy: more back-and-forth means harder to resolve
- Tags like "bug", "urgent", "escalation" amplify severity
- **Bias warning**: reactive signals skew toward vocal users and broken things, not growth opportunities

### Proactive Signals (ProductLift feature requests)
- Customers telling you what they WANT, not just what's broken
- Vote counts measure breadth of demand
- Comments measure depth of conviction
- **Bias warning**: proactive signals skew toward power users who find your roadmap page

## Signal Weighting Rules

1. **Neither source alone is sufficient.** A theme only in support tickets might be a temporary bug. A theme only in feature requests might be a niche want.
2. **Convergent signals are 2x priority.** When the same theme appears in BOTH support tickets AND feature requests, it's validated from two independent customer behaviors. This is the strongest signal.
3. **Frequency is necessary but not sufficient.** 50 people asking for dark mode matters, but 5 people unable to log in is more urgent.
4. **Recency matters.** A spike in the last 7 days outweighs a steady trickle over 90 days — it may indicate a regression or a market shift.

## Scoring Formula

\`\`\`
priority_score = (frequency × 0.35 + severity × 0.35 + vote_momentum × 0.30) × convergence_boost
\`\`\`

- **Frequency (0.35)**: Count of data points, normalized to max across all themes
- **Severity (0.35)**: Reactive signals only — thread count, recency (exponential decay), tag boost
- **Vote Momentum (0.30)**: Proactive signals only — 80% votes + 20% comments, normalized
- **Convergence Boost (2×)**: Applied when theme has BOTH reactive AND proactive signals

## Balancing Reactive vs Proactive

### When to prioritize reactive (fix what's broken):
- Severity score > 70 for any theme
- Tags include "escalation" or "critical"
- Thread counts averaging > 5 (long painful conversations)
- Revenue-impacting issues (billing, auth, performance)

### When to prioritize proactive (build what's wanted):
- Vote momentum score > 70 with low severity
- Feature requests align with strategic product direction
- Competitive pressure (customers mentioning competitor features)
- Retention-focused themes (integration requests from power users)

### The 80/20 Rule
- Typically 80% of product impact comes from addressing the top 3 themes
- Don't spread thin across 10 initiatives — go deep on 3-5
- One convergent theme is worth more than three single-source themes

## When KPI Context Is Available

When business metrics from external sources (Metabase, GA, etc.) are provided:

1. **Churn data elevates retention themes**: If churn is rising, weight reactive signals higher — fix what's pushing people away
2. **Traffic/growth data elevates acquisition themes**: If growth is strong, weight proactive signals higher — build what attracts new users
3. **Revenue per segment data focuses priorities**: If enterprise customers drive 80% of revenue, weight their signals proportionally
4. **Usage analytics validate demand**: If a feature request has high votes but low usage of related features, discount it
5. **Never let metrics override convergent signals**: A convergent theme + supporting metrics = highest confidence priority

## Revenue vs User Satisfaction

This is not a binary choice. Use this framework:

| Situation | Lean toward |
|-----------|-------------|
| Churn rising + billing/auth themes hot | Revenue protection (reactive) |
| Growth strong + integration requests | User satisfaction (proactive) |
| Convergent theme in any category | Address it regardless — both sides agree |
| Conflicting signals | Default to reactive — you can't grow if existing users are leaving |

## Output Format for Product Plans

For each recommended priority:
1. **Theme name** and category
2. **Signal type**: reactive, proactive, or convergent (strongest)
3. **Evidence summary**: X support tickets, Y feature requests, Z total votes
4. **Customer quotes**: 2-3 representative quotes showing the pain/desire (PII-scrubbed)
5. **Recommended action**: Specific, actionable next step (not vague "improve X")
6. **KPI connection** (if metrics provided): How this ties to business outcomes

## Anti-Patterns to Avoid

- **Recency bias**: Don't over-index on this week's loudest ticket
- **Squeaky wheel**: One customer filing 10 tickets ≠ 10 customers with the problem
- **Feature factory**: Don't just build the most-voted feature — check if it aligns with product strategy
- **Metric theater**: Don't cite a KPI just because it exists — only reference metrics that genuinely affect prioritization
`;
