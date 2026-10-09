# Ownership: invite conversion at 11%

**Scenario (supplied, not observed):** open-to-claim conversion is 11% against the 25% target in [PLANS.md §4.2](PLANS.md#42-metric-definitions-targets-and-improvement-triggers). With no real users, every number here is a scenario assumption or synthetic illustration.

**First, trust the number.** The trigger needs at least 200 mature journeys, so check the sample size and 95% interval. Confirm the measure: unique `(invite, guest journey)` opens, counting attributed claims within the earlier of 24h and activity start, excluding recovery reopens, unfurlers, repeat opens and synthetic traffic. Read the headline rate (including full or expired previews) beside the eligible-open rate.

## Ranked hypotheses (by likely size × cheapness to check; not evidence until confirmed)

| # | Hypothesis | Confirming evidence | Segment / stage |
|---|---|---|---|
| 1 | Guests open invitations that can no longer be claimed (full, expired or started) | Headline far below the eligible rate; many opens are not `valid` | Availability at open |
| 2 | New guests abandon at identity setup | Steep drop from open to `identity_created` for new viewers, not for returning ones | New vs returning; funnel stage |
| 3 | The web-preview → Flutter handoff loses guests or their journey | Few app opens after web previews; code entry converts worse than links | Platform |
| 4 | Rail mix: low-intent public opens dilute the average | Rails differ and the mix shifted toward public. Compare within each rail first | Rail |
| 5 | Claims are attempted but fail (wrong recipient, lost last seat, technical error) | `invite_claim_attempted` without `spot_claimed`; failure reasons; reliability below 99.5% | Claim stage; rail |

## Measurable improvements (build only what the segments support)

- **H1:** show seats left and expiry when sharing; route full previews onward. Measure: non-`valid` open share.
- **H2:** one-step identity on the claim screen. Measure: new guests' open-to-identity rate.
- **H3:** a code-preserving app-open path from the web preview. Measure: preview → app open → claim.
- **H5:** explain recipient mismatch before claiming. Measure: attempts per successful claim.

## The appropriate control

The persisted **activity-level no-invite holdout** ([§4.4](PLANS.md#44-holdout-design)) asks whether invitations add confirmed participants and formed plans per assigned activity. Its control has no invitations, so no open-to-claim rate: it cannot test a conversion fix. Keep it unchanged.

Test fixes as a separate **guest-UX comparison with invitations enabled in both arms** (original vs improved flow), randomised by activity among treatment activities only. Guests on one plan share seats and a public link's opens are correlated, so analyse with activity-clustered errors. As a synthetic illustration, detecting 11% → 15% at 80% power and α=0.05 needs about 1,110 mature journeys per arm, or about 1,450 with an assumed design effect of 1.3. Measure real clustering before fixing duration. Cross-plan spillovers remain (one guest can see both arms via different activities): report their extent; production may need community-level clustering.

## Decision at a predeclared review point

Review once each arm reaches the computed sample and two full weeks, with no interim peeking.

- **Ship** if the clustered 95% interval for eligible-open lift is above zero, the headline rate does not fall, and every guardrail holds.
- **Iterate** if it spans zero: keep the original flow; test the next hypothesis.
- **Roll back** on any guardrail breach: an oversell or counter mismatch; booking success below 99.5% (S/(S+F), with S/(S+F+U) shown); live p95 above 2s or recurring delivery misses; or fewer participants or formed plans per assigned activity.
- Reaching 25% clears the trigger but is not required to ship a measured gain.

A formed plan (≥2 confirmed participants) is provisional, not attendance, which stays unmeasured; cancellations and no-shows join the guardrails once measured. K has no invented target. No real-user causal lift is claimed.

## Next action

This week, decompose the 11% by availability at open, new/returning, platform, rail and funnel stage, using existing queries and no new code. If H1 dominates, supply and expiry are the levers, not the guest UX. Expanding the invite rollout rests on the holdout's participant and formed-plan outcomes and guardrails, never on conversion alone.
