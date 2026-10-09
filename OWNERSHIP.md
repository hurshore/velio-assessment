# Ownership: improving invitation conversion

**Supplied scenario:** Thirty days after launch, overselling is zero and booking SLOs are healthy. Invitation creation is 34% against 30%; open-to-claim conversion is 11% against 25%. Most opens are mobile, and vouches convert better than public links. This is hypothetical; prototype evidence uses synthetic data.

## Diagnose

Validate the 11% using PLANS.md §4.2: deduplicated (invitation, guest journey) opens, mature claim windows (the earlier of 24 hours and activity start), server attribution, recovery/bot/test exclusions, and effective opens clamped to creation/receipt with five-minute claim skew tolerance. Compare headline conversion, including unavailable invitations, with eligible-open conversion. Split by availability, platform, invitation type, new/returning and funnel stage; anonymous at first open does not necessarily mean new. Observe mobile journeys and ask guests who stopped why. Compare invitation types on volumes and participation alongside rates.

## Improve, ranked by expected impact and effort

Priorities are provisional; investigate these hypotheses before choosing the first change.

| # | Hypothesis and proposed change | Impact / effort |
|---|---|---|
| 1 | **Mobile handoff** (platform): preserve invitation context after a fresh installation; installed-app links already retain it. | High if common / medium-high |
| 2 | **Identity friction** (new/returning, stage): test signup and claim in one action, retaining progress on failure. | High / medium |
| 3 | **Unavailable invitations** (availability): emphasise seats and expiry when sharing; offer other available activities after sellout. | High if common / low-medium |
| 4 | **Public-link uncertainty** (invitation type): test inviter messages and clearer commitment copy; preserve the public-link trust distinction. | Medium / low-medium |
| 5 | **Claim rejection** (claim stage, type): improve contact and identity guidance and last-seat outcomes; repair concentrated technical failures. | High for affected guests / low-medium |

I would record entry method (app link or typed code), handoff and loading outcomes, identity-step failures and invitation-flow assignment; SQL cannot recover unrecorded steps. Funnel stages, headline-conversion segments and longer experiments need additional SQL: #10's metrics segment invitation type, platform and new/returning over eligible opens only, and report at most seven days. Count alternative-activity bookings separately from original-invitation conversion.

## Prove it

Keep the activity-level no-invite holdout for additional participants and provisional formed plans across all assigned activities. Separately randomise invite-enabled activities to the original or improved invitation flow. Test one change: primary outcome is headline open-to-claim conversion; also compare eligible-open conversion and participation.

Predeclare the minimum useful gain, acceptable participation harm and review date. Illustratively, 11% to 15% needs about 1,110 journeys per arm before clustering (80% power; two-sided 5% significance). Account for actual clustering and sufficient independent activities; run at least two weeks and let final claim windows close. Report cross-activity guest overlap; friend spillovers between arms remain a limitation and may bias both comparisons.

Monitor safety continuously: stop rollout on overselling or counter mismatch; require 99.5% logical-intent booking success (exclude replays), showing the conservative unknown-failure rate, and live p95 within two seconds with delivery coverage. Apply §4.2's sample thresholds (1,000 intents; 50 updates) and recurring-failure exceptions. Ship a useful gain with its activity-clustered 95% interval above zero and guardrails satisfied; investigate inconclusive results and revert harmful changes. Attendance remains unmeasured.

## Decide

If conversion still misses 25%, I would retain useful improvements while the holdout shows participation worth its cost. After two adequately sampled iterations, reassess: constrain or remove an invitation type if evidence rules out useful lift or harm persists. Inviters choose the type, so this needs a randomised comparison of offered types, not observed rates. Discuss separate invitation-type targets with the product owner only when evidence supports them, retaining the original goal and measure. Next, locate the largest mobile drop-off and choose the first change from that evidence.
