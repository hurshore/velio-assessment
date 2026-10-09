# Issue #10: queryable metrics verification

Verified locally on 9 October 2026 against PLANS.md §1.3–1.5, §4.1–4.4. Node 24.21.0/npm 11.19.0, PostgreSQL 17.6 and Redis 8.2.1 in Docker, macOS host. Each integration run owns and removes its isolated database; metrics fixtures are inserted with migration credentials and fixed historical timestamps, like the labelled seeds.

## Executed checks

- Full backend suite: 129 tests pass, including the 11 new `backend/test/metrics.test.ts` scenarios. Web: 104 tests in 9 files pass; root script tests: 12 pass; mobile unchanged and passing (`flutter analyze` clean, 13 tests).
- `npm run typecheck` and `npm run build` pass across workspaces. `npm run seed` was executed twice against a scratch migrated database: all five seed files apply cleanly and `metrics.sql` is idempotent on replay.

## Hand-calculated labelled fixtures

`backend/test/metrics.test.ts` builds one cross-referenced synthetic universe in the window 2026-10-01T00:00:00Z..2026-10-08T00:00:00Z and asserts endpoint output against expectations computed by hand from the §4.2 definitions (the same scenarios are reproduced for manual inspection by `backend/seeds/metrics.sql` with `includeTest=true`):

- **Reliability:** six raw outcomes over seven distinct logical intents. A retried eligible technical failure that commits, a replay of a committed result and a commit exactly at the window start make S=3; an eligible failure (F=1) and an unknown-eligibility failure (U=1) stay visible, giving S/(S+F)=0.75 and S/(S+F+U)=0.6; sold-out and invalid outcomes are excluded from the rates but present in raw counts; a commit exactly at the window end is excluded; the two attempts behind the eventual success stay countable. Status is `insufficient_sample` below the 1,000-intent trigger.
- **Integrity:** an owner write leaves two booking rows on a one-seat activity with a zero counter; the summary reports exactly that oversold and mismatched row with its counts.
- **Booker-to-inviter:** 19 mature first-in-window bookings; one booker invites 23h after booking (public) and one 10h after (vouch) for 2/19 with a Wilson 95% interval; the 25h-late invite and the invite for the wrong (second) activity do not count; a booking 25h before the window end is reported as not-yet-mature with its invite; a pre-window booking does not qualify its user; the host's own invite appears only in the separate non-booking host-creator segment.
- **Open-to-claim:** nine mature deduplicated `(invite, journey)` units. A repeated open counts once; claims at exactly 24h convert and a claim after activity start does not (the earlier-of-24h/start deadline); a full-preview open converts in the headline (5/9) but not the eligible rate; a returning booker's recovery reopen is excluded from eligible opens (4/7) and diagnosed in reason breakdowns; rail/platform/availability-at-open/new-returning segments and the not-yet-mature unit are asserted exactly.
- **K:** the cohort fixed at window start (5: the host, two pre-window bookers and two seed cohort members, including a never-inviter) acquires 2 vouch (both activated) and 6 public (5 activated) users: K 0.4/1.2, activated K 0.4/1.0. A user acquired by an in-window-only booker and a generation-2 descendant stay out of direct K and appear in the generation breakdown (9 + 1).
- **Holdout:** four assigned activities under one experiment version, none with exposure or invitation events: treatment 3+1 participants with one formed plan, control 2+0 with one formed plan; the participant difference (+1) carries the Welch 95% interval ±1.96·√2; attendance is labelled unmeasured and the block is observational-only.
- **No fabricated data:** an eventless window returns null rates and `no_data` in every block, and `includeTest=false` excludes all synthetic traffic from both endpoints.

## Measurement scope and limits

Rates come from locally seeded synthetic events, not production traffic: the 99.5% reliability, 2s live p95, 30% and 25% targets are reported with sample counts, Wilson intervals and `no_data`/`insufficient_sample`/`observed` statuses, and no attainment is claimed. Reliability intents are grouped from recorded outcome context inside the requested window; requests whose activity cannot be resolved never enter S/F/U. Open units depend on client-reported `invite_opened` events (human renders only by contract); cross-device visitors without a persistent journey remain a stated limitation. Holdout participants are current committed bookings at query time for activities assigned in the window; the interval is descriptive, activity-level clustering is only partially captured by a two-arm Welch interval, and no causal claim is made. Live latency/coverage detail remains owned by `/api/metrics/live`; the summary repeats only its headline aggregates. Real Flutter event verification through these queries for both rails is the final handoff criterion tracked by the plan, outside this ticket.

## Review

### Standards

Diff reviewed with the code-review skill against `CONTRIBUTING.md`/`CODING_STANDARDS.md`; findings and dispositions are recorded in the PR.

### Spec

Diff reviewed with the code-review skill against issue #10's acceptance criteria and PLANS.md §4; findings and dispositions are recorded in the PR.
