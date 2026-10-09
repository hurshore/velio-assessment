# Issue #10: queryable metrics verification

Verified locally on 9 October 2026 against PLANS.md §1.3–1.5 and §4.1–4.4. Node 24.21.0/npm 11.19.0, PostgreSQL 17.6 and Redis 8.2.1 in Docker, macOS host. Each integration run creates and drops its own database.

## Executed checks

- `npm run test --workspace backend`: 140 tests pass after merging current `main`. This includes 17 scenarios in `backend/test/metrics.test.ts` and 3 in `backend/test/seed.test.ts`.
- Web: 104 tests. Root scripts: 12 tests. `npm run mobile:check`: Flutter analysis clean, 48 tests (including the guest-journey suites from #8 and #9).
- `npm run typecheck`, `npm run build` and `git diff --check` pass.
- Migration 012 has never been applied to a persistent database; the local dev database is at 011.

## Test-only fixtures (`metrics.test.ts`)

Fixtures are inserted with migration credentials and fixed timestamps. Expectations are calculated by hand from the definitions in the [contract](../contracts/api.md#queryable-technical-metrics-funnels-and-holdout-issue-10). Several states here cannot come from production writers, so they live only in the isolated test database: an oversold activity, a claim after activity start, and clock-skewed opens.

**Reliability**

- Window 2026-10-01..10-08 holds 11 raw outcomes, grouped into 10 logical intents.
- Succeeded (S=2): an eligible failure retried into a commit, and a commit exactly at the window start.
- Failed (F=1): one eligible failure.
- Unknown (U=4): an unknown failure; a failure whose identity never resolved; and two unrelated failures whose activity never resolved, kept apart rather than merged.
- Excluded but reported: one replay-only, one sold-out-only and one invalid intent.
- A commit exactly at the window end is excluded.
- Result: S/(S+F) = 2/3, S/(S+F+U) = 2/7, technical-error rate 6/11, one retried intent.

**Live delivery**

- E1: two subscribers; one ACK at 500 ms, one miss.
- E2: committed with nobody subscribed.
- E3: one ACK at 1,200 ms from its origin gateway, plus a second gateway's proxy observation with no subscribers.
- Commit-observed group: 3 observed bookings, 2 with subscribers, 3 expected deliveries, 2 ACKs, 1 miss, 0 pending, p95 1,200 ms, attainment false. The proxy group reports 1 observed booking, 0 expected deliveries and null attainment.
- A window containing only E2 reports `no_expected_deliveries` with null attainment.
- The summary equals `/api/metrics/live` field for field in every window checked: full, zero-subscriber-only, mixed, and filtered.

**Integrity**

- One oversold activity plus 101 counter-only mismatches gives 102 violating activities.
- The response returns 100 detail rows, oversell first, with `truncated: true` and `omittedViolations: 2`.
- The violations stay visible with `includeTest=false`.

**Booker-to-inviter**

- 22 mature first-in-window bookings: 14 at generation 0, 8 at generation 1.
- 2 invited: one at 23h, one vouch at 10h. The invite at 25h and the invite for the wrong activity do not count.
- One booker is not yet mature. One host is counted as a creator without a booking.

**Open-to-claim**

- 8 mature acquisition units: headline 5/8, eligible 4/7. A repeated open counts once, and a claim exactly 24h after the open converts.
- A claim after activity start does not convert. A full-preview conversion counts in the headline only.
- One recovery reopen is reported separately.
- Timing window (2026-09-10..09-17), 7 units, 5 conversions:
  - a clock 3 s ahead is clamped to receipt;
  - an ahead clock whose open was uploaded after the claim converts within the 5-minute tolerance;
  - a clock 4 h behind is clamped to invite creation and keeps a claim made 23.5 h later;
  - an offline upload 2 h late keeps its occurrence time;
  - a claim 30 minutes before the open does not convert;
  - a journey that opens two invites converts only on the invite it claimed through.
- The view definition contains the policy module's 24 h and 5-minute constants.

**K**

- Cohort of 5, which includes non-inviters.
- Vouch: 2 acquired, 1 activated, K 0.4, activated K 0.2. One vouch guest only booked directly, so activation needs a claim.
- Public: 6 acquired, 5 activated, K 1.2, activated K 1.0.
- 9 users at generation 1 and 1 at generation 2. A 3-day window is labelled `partial_window`.

**Holdout**

- Four activities assigned with no exposure events.
- Treatment: 3+1 participants. Control: 2+0 participants. Each arm has one formed plan.
- A control booking after the window ends is excluded.
- Difference +1 participant per activity, interval ±1.96·√2.

**Marker alignment** (window 2026-10-20..10-27, unmarked data)

- A test-marked participant leaves the holdout count, and a control activity with only a marked participant stays in its arm with zero.
- A marked host's acquisition is excluded from direct K and from the generation breakdown.
- An unmarked open claimed by a marked actor is excluded.

**Bounded reporting**

- A report snapshot runs as `repeatable read`, read-only, with a 1500 ms statement timeout.
- Six concurrent product reports all return identical results.

## Seed demonstration

`backend/seeds/metrics.sql`, applied by `npm run seed`, is a production-shaped demonstration in the window 2026-09-01T00:00:00Z..2026-09-08T00:00:00Z. No other seed writes to that window. Query it with `includeTest=true`; with the default `includeTest=false` the windowed blocks show no data. `backend/test/seed.test.ts` applies every seed file twice to a fresh database and checks these results:

| Block | Scenario | Expected result |
|---|---|---|
| Integrity | All 13 seeded activities across every seed file, counters reconciled | 13 checked, 0 violations (also in the default view) |
| Reliability | R1: eligible failure, then commit, then replay (one intent). R2: unknown failure. R3: sold out. R4: invalid | Raw 6 outcomes (1 committed, 1 replay, 1 sold out, 1 invalid, 2 technical) and 2 attempts; 4 intents, 1 retried; S=1, F=0, U=1; eligible rate 1.0, unknown-inclusive 0.5; sold-out and invalid excluded |
| Booker-to-inviter | 7 first in-window bookings. G1 invites 70 minutes after booking (IG, public) | 1/7 invited; generation 0: 5 bookers, 0 invited; generation 1: 2 bookers, 1 invited; 1 host creator without a booking |
| Open-to-claim | 8 units. G1 opens twice and claims (J1). An expired open (J2). G1's recovery reopen (J3). An unclaimed open (J4). The vouch claim (J5). An open that hits the start deadline unclaimed (J6). Returning booker B0 claims (J8). An open of G1's generation-1 invite (J9) | Headline 3/7, eligible 3/6; displayed valid 6 (3 converted), expired 1 (0 converted); 1 recovery open; public 5/2, vouch 1/1; mobile 3/1, web 3/2; inviter generation 0: 5/3, generation 1: 1/0; new 5/2, returning 1/1 |
| K | Cohort: host H (hosted before the window) and B0 (booked before it). G1 (public), G2 (vouch) and G3 (public) are acquired by H; G4 is generation 2 via G1 | Cohort 2; vouch acquired 1, activated 1 (K 0.5/0.5); public acquired 2, activated 1 (K 1.0/0.5); generation 1: 3 users, generation 2: 1 user |
| Holdout | Version `seed-metrics-holdout`: treatment HT with 2 participants; control HC with 1 participant and HC2 with none | Treatment 1 activity, 2 participants, 1 formed plan; control 2 activities, 1 participant, 0 formed plans; difference +1.5 participants per activity (no interval below two activities per arm), +1.0 formed-plan rate |
| Live | No outbox or delivery rows | `no_data` |

What the seed deliberately omits, because production writers cannot create it or because it would damage a demo database: integrity violations, claims after activity start or after expiry, exact 24 h boundaries, clock skew, live deliveries and marked participants.

## Reliability policy check

The classification was checked against PLANS.md §4.2: "Reliability excludes invalid domain requests, sold-out decisions and idempotent replay requests from new logical intents". Unknown-eligibility failures stay counted in the companion rate.

The production event shapes were traced through the grouping:
- `bookSeat` outcomes carry the activity in `context.activityId` and the invite in `invite_id`.
- `recordInvalidBooking` carries a resolved activity in its column, and no activity when the path did not resolve.
- So a failed request and its committed retry, with the same or a new idempotency key, form one intent, while unrelated unresolved failures do not merge.

Invalid domain requests (`outcome: invalid`, `eligibility: ineligible`) are never counted as technical failures. Unknown-eligibility technical failures are counted in U.

## Performance measurements

Scale runs used a throwaway script against isolated databases: 2,000 invites over 60 days, about 1.3 opens per journey, a quarter of journeys claiming, and as many booking outcomes as opens. The pool had the API's 1.5 s driver deadlines. Each report covered 7 days; timings are the median of 5 sequential requests.

| Opens | Total events | `/product` median | `/summary` median | Open-unit view scan | 6 concurrent `/product` |
|---|---|---|---|---|---|
| 50,000 | 131,514 | 85 ms | 34 ms | 76 ms | all 200, 235 ms |
| 200,000 | 524,958 | 265 ms | 57 ms | 214 ms | all 200, 1,030 ms |
| 500,000 | 1,313,206 | 791 ms | 140 ms | 528 ms | all 200, 2,226 ms |
| 1,000,000 | 2,624,866 | 1,422 ms, then a 500 | 351 ms | 1,351 ms | all retryable 500s, 4,588 ms |

What changed:
- Each report holds one pooled connection; earlier, open-to-claim alone fanned nine queries out across the pool.
- The view is evaluated once per report instead of nine times.
- Windowed event reads use the new `(name, occurred_at)` index.
- Concurrent reports queue two at a time instead of draining the booking pool.

**Deferred limitation:**
- `metric_invite_open_units` deduplicates over the full `invite_opened` history before the window applies. This preserves first-open semantics across window boundaries.
- Its cost therefore grows with total history: about 0.53 s at 1.3M events and 1.35 s at 2.6M.
- Past roughly 2.5M events, the product report exceeds the 1.5 s statement deadline and returns a retryable 500. The summary is unaffected.
- The fix is deferred: prune candidates by window (opens whose occurrence or receipt falls in the window, or whose invite was created in it, plus an indexed earlier-open check), or keep an ingestion-maintained unit table.
- Not measured: multi-node API deployments, production hardware and longer statement budgets.

## Measurement scope and limits

**Synthetic data only.** Rates come from synthetic local fixtures, not production traffic. The 99.5% reliability, 2 s live p95, 30% and 25% targets are reported with counts, intervals and statuses; no attainment is claimed.

**Open timing.** Open times come from client clocks, bounded as described in the contract. Within those bounds, skew can still move an open across a window edge. Reports count only opens ingested by query time, so a late upload can change an already-run report. Cross-device journeys without a shared journey ID remain uncorrelated.

**Holdout.** The holdout difference is descriptive. A two-arm Welch interval only partly reflects activity-level clustering, and attendance is unmeasured.

**Live timing.** Detailed live latency remains owned by `/api/metrics/live`, including its single-process timing scope and its manual crash-lifetime reconciliation.

**Flutter.** Checking real Flutter events through these queries for both invite types is the final handoff step, outside this ticket.

## Review

### First review (two-axis)

The independent sub-agents could not run, so the primary agent reviewed the diff directly. It fixed:
- the open-to-claim headline, which included recovery opens;
- activated K, which counted direct bookings;
- holdout participants, which were read at query time instead of the window end;
- missing segments;
- dropped unresolved failures;
- the missing retry/error rates;
- a K window that was never labelled.

### Second review (code-review-v3)

Nine Sonnet sub-agents reviewed the PR, one per criterion. They found 4 Major, 11 Minor and 4 Potential findings, all addressed in this revision:

- **Zero-subscriber bookings (Major):** counted as expected, pending deliveries. The summary now reuses the live report function, and zero-subscriber and mixed fixtures check parity.
- **Filtering, seed and reliability documentation (three Majors):** rewritten to describe the actual behavior. Integrity is documented as global, the seed's contents are listed with their expected results, and the replay policy is corrected.
- **Clock skew:** handled by the clamped effective open and the 5-minute tolerance.
- **Merged unresolved failures:** each unresolved request is now its own intent.
- **Inconsistent marker sources:** aligned through one `unmarked()` helper, including holdout participants and acquisition parents.
- **Duplicated live rules:** removed.
- **Unbounded integrity detail:** capped at 100 rows with totals and a truncation flag.
- **Threshold literals:** moved into `metric-policy.ts`.
- **Repeated scans and the parallel query burst:** fixed by evaluating the view once and running each report in one snapshot.
- **Stale comments and inaccurate field descriptions:** corrected.
- **File layout:** the technical summary is split into `summary-metrics.ts`.

Deferred: the full-history open scan described above.
