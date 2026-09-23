# Theme-matching evaluation

The scoring formula only matters if the theme matching underneath it is right. `npm run eval` measures that.

## Why keyword matching

Themes are matched with keyword lists, not embeddings or an LLM classifier. Single-word keywords match on a word boundary with an optional regular plural suffix; multi-word keywords also match on word boundaries. That's a deliberate trade-off:

- Customer text never leaves the server for a third-party embedding or classification API. The PII guarantees in [SECURITY.md](../SECURITY.md) only hold because nothing in the matching path makes a network call.
- The same input always produces the same themes, so a priority ranking can be audited and explained. An LLM classifier would reshuffle rankings between runs.
- No token cost or latency per data point.

The cost is recall. Keyword lists miss paraphrases, and they miss them unevenly across products. On held-out live chat data a third of conversations still match no theme. The eval exists to quantify that, and it's published rather than hidden.

## Running it

```bash
npm run build && npm run eval
npm run eval -- --failures        # every miss and false positive
npm run eval -- --json            # machine-readable report
npm run eval -- --min-f1 0.90     # non-zero exit below threshold (CI runs this)
```

Matching is multi-label (one signal can belong to several themes), so the report gives per-theme precision, recall and F1, plus two rates that matter more than the averages: `miss rate` (expected a theme, matched nothing) and `false alarm rate` (expected nothing, matched something). It also breaks results down by register (chat, roadmap, ticket).

## What the first run found

The eval's first job was auditing the v2 config. It found five real defects:

- Plural coverage was inconsistent. `tier` was listed without `tiers`, and single-word keywords matched on a bare word boundary, so "the tiers" matched nothing. On live chat data this was the expensive one: a recurring preset question about plans and prices matched no theme at all, because `plan` missed "plans" and `pricing` missed "prices".
- `team` fired on "founding team" and "IT team", half the false positives in the fixture.
- `plan` tagged "i plan to launch next week" as Account & Licensing.
- `upgrade` sat in both Billing & Payment and Account & Licensing, so an API ticket mentioning an upgrade landed in both.
- Multi-word keywords were exact substrings, so `cant login` missed "cant log in" and `outlook calendar` missed "does this work with outlook".

All five are fixed in v3. Single-word keywords match an optional regular plural suffix, over-generic keywords were scoped (`team` → `my team` / `team member` / `teams`), duplicated keywords were assigned to one theme, and the missing variants were added. Two new themes came out of real unmatched conversations, Giveaways & Contests and List & Contact Management, which the config had no vocabulary for at all.

## Baseline

Two numbers, because they measure different things.

Against the committed fixture (86 hand-labelled examples as of 1.5.0; the v2 row was measured on the original 82), micro-averaged:

| config | precision | recall | F1 | miss rate |
|---|---:|---:|---:|---:|
| v2 | 88.7% | 68.8% | 77.5% | 25.0% |
| v3 | 96.1% | 99.0% | 97.5% | 1.3% |

Treat that with suspicion. The config was iterated against this fixture, so the v3 figure is in-sample and flatters itself. It's a regression gate: it tells you a change broke something, not how well matching works.

The number that means something is held-out real data: 1,100 chat conversations across four products, from a 30-day window *before* the one the new themes were derived from.

Unmatched conversations fell from 39.9% (v2) to 33.1% (v3). The biggest gains came from the products whose vocabulary the config never covered, and a third of conversations still match nothing, so there's plenty left.

Register mattered less than product coverage. For one product, chat was *better* matched than its tickets, so chat phrasing isn't the problem on its own. Missing product vocabulary is, and per-product chat agents expose that where a shared support mailbox averages it away.

## Known limits

- **Canned widget prompts inflate counts.** Preset question buttons in a chat widget recur verbatim dozens of times. They aren't deduplicated, on purpose: twenty people clicking a preset is twenty people with that question. It does mean volume for a theme with a popular preset isn't comparable to volume for one without.
- **Matching is English-only.** Live data includes German, Spanish and Italian conversations, and all of them land in `unmatched`.
- **Irregular plurals still need listing.** The suffix rule covers `plan`/`plans`, not `entry`/`entries`.

## Evaluating your own data

Export signals to a local JSONL in the fixture's shape (`evals/theme-matching.jsonl`) and pass `--fixture ./local/real.jsonl`. Real fixtures contain customer text, so keep them out of git.
