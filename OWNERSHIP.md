# Ownership: invite conversion at 11%

**Scenario (supplied, read via PLANS.md):** open-to-claim conversion is 11% vs the [§4.2](PLANS.md#42-metric-definitions-targets-and-improvement-triggers) 25% target. No real users exist; every number is a scenario assumption or synthetic illustration.

**First, trust the number.** Check the 200-mature-journey trigger and the 95% interval, then confirm the measure: unique `(invite, guest journey)` opens, counting attributed claims within the earlier of 24h and activity start, excluding recovery reopens, unfurlers, repeat opens and synthetic traffic. Read the headline rate (including full or expired previews) beside the eligible-open rate.

## Ranked hypotheses (by likely size × cheapness to check; not evidence until confirmed)

| # | Hypothesis | Confirming evidence | Segment / stage |
|---|---|---|---|
| 1 | Guests open invitations that can no longer be claimed (full, expired, started or cancelled) | Headline far below the eligible rate; many opens are not `valid` | Availability at open |
| 2 | New guests abandon at identity setup | Steep drop from open to `identity_created` for new viewers, not for returning ones | New vs returning; funnel stage |
| 3 | The web-preview → Flutter handoff loses guests or their journey | Few app opens after web previews; code entry converts worse than links | Platform |
| 4 | Rail mix: low-intent public-link opens dilute the average (a mix effect, not a fix) | Rails differ and the mix shifted toward public. Compare within each rail first | Rail |
| 5 | Claims are attempted but fail (wrong recipient, lost last seat, technical error) | `invite_claim_attempted` without `spot_claimed`; failure reasons; booking success below 99.5% | Claim stage; rail |

## Measurable improvements (only where segments support them)

- **H1:** show seats left and expiry when sharing; route full previews onward. Measure: non-`valid` open share.
- **H2:** one-step identity on the claim screen. Measure: new guests' open-to-identity rate.
- **H3:** a code-preserving app-open path from the web preview. Measure: preview → app open → claim.
- **H5:** explain recipient mismatch before claiming. Measure: attempts per successful claim.

## The appropriate control

The persisted **activity-level no-invite holdout** ([§4.4](PLANS.md#44-holdout-design)) asks whether invitations add confirmed participants and formed plans per assigned activity. Its control has no invitations, so no open-to-claim rate: it cannot test a conversion fix. Keep it unchanged.

Test fixes as a separate **guest-UX comparison with invitations enabled in both arms** (original vs improved flow), randomised by activity among treatment activities only. A plan's guests share seats and a link's opens correlate, so use activity-clustered errors. As a synthetic illustration, detecting 11% → 15% at 80% power and α=0.05 needs about 1,110 mature journeys per arm, or about 1,450 with an assumed design effect of 1.3. Measure real clustering before fixing duration. Cross-plan spillovers remain (one guest can see both arms via different activities): report their extent; production may need community-level clustering.

## Decision at a predeclared review point

Review once each arm has the computed sample and two full weeks; no interim peeking.

- **Ship** if the clustered 95% interval for headline lift (the powered metric) is above zero, eligible-open conversion shows no clear decline, and every guardrail holds.
- **Iterate** if it spans zero; **revert** if it is below zero. Either way, test the next hypothesis.
- **Roll back** on any guardrail breach: an oversell or counter mismatch; §4.2 booking success below 99.5% (S/(S+F), conservative S/(S+F+U) shown); live p95 above 2s or recurring delivery misses; or an interval showing fewer participants or formed plans per assigned activity.
- Reaching 25% clears the trigger but is not required to ship a measured gain.

A formed plan (≥2 confirmed participants) is provisional, not attendance, which stays unmeasured; cancellations and no-shows join the guardrails once measured. K-factor has no invented target. No real-user causal lift is claimed.

## Next action

This week, decompose the 11% by availability at open, new/returning, platform, rail and funnel stage, using #10's segments plus ad hoc SQL over raw events for stage and entry method. If H1 dominates, supply and expiry are the levers, not the guest UX. Expanding the invite rollout rests on the holdout's participant and formed-plan outcomes and guardrails, never on conversion alone.
