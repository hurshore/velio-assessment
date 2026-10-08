# Issue #7: live availability verification

Verified locally on 8 October 2026 against PLANS.md §2.5, §2.9, §3.1–3.2 and §4.1–4.3. Node 24.21.0/npm 11.19.0, PostgreSQL 17.6 and Redis 8.2.1 in Docker, macOS host. Each integration run owns and removes its isolated database; a test-owned TCP proxy interrupts only its Redis connections.

## Executed checks

- Full `npm test`: 12 root, 81 backend and 76 web tests pass. Seventeen real-service live scenarios and nine rendered activity-view scenarios pass, alongside all 16 booking regressions.
- `npm run typecheck`, `npm run build`, and `git diff --check` pass.
- Existing mobile verification: Flutter analysis clean, all 13 tests pass. Mobile files were unchanged in these corrections.

The integration suite starts two actual API processes sharing PostgreSQL and Redis. Rendered-view tests replace only HTTP/WebSocket transport. The ACK send callback inspects already committed DOM counts, participants and full-state copy. Foreground return after a long hidden interval retains a healthy socket and gives refresh a fresh watchdog grace period.

## Measured workload

The full-suite run issued 50 distinct booking writes together, allowing transactions to overlap behind the activity lock. All 50 committed; all 50 expected deliveries were ACKed, with **100% eventual and on-time coverage, zero misses**, ACK-only per-booking-max p95 **916.76 ms**, maximum **961.45 ms**. One foreground client contributed all 50 samples, so its actual client p95 equals the booking-max p95 in this workload. This does not establish a many-client load target.

The deliberate missing-ACK scenario retains two expected clients with one ACK: 50% coverage and a failed attainment verdict. Fully missed bookings and clients remain represented with null/no-data latency. The mixed pending/finalized scenario confirms a finalized miss makes the verdict false immediately. A late ACK improves eventual coverage without improving on-time coverage or erasing its miss.

## Correctness and recovery evidence

- Graceful shutdown under traffic rejects new work, independently drains accepted HTTP and booking operations while still observing commits, persists one exclusive observation cutoff, reconciles before it, and drains observation writes before PostgreSQL closes. The test commits a blocked local booking and a concurrent remote booking during shutdown; both observations persist and the process exits successfully. Subsequent bookings do not demand observations from that retired gateway.
- Redis interruption preserves successful bookings and durable dispatch retries. Subscription races and duplicate/reordered publication retain current counts, full membership and version guards. Slow observation storage plus concurrent publication retains the exact local clock.
- Failed telemetry inserts still send current untagged availability; instrumentation failures/gaps remain visible. Observation retry preserves the original captured cohort and timing. ACK-write failure keeps the socket open and retries the original arrival clock from a bounded rotating queue; a scoped fault verifies availability continues and the original on-time duration survives delayed storage. An already expired proxy measurement still sends a snapshot and accepts a valid late ACK. UUID case normalization is exercised through subscribe/ACK.
- Hiding/disconnecting after observation never removes expected deliveries. Expired in-memory retransmissions retire, current snapshots continue, and durable late-ACK verification remains available after memory expiry and restart.
- A 105-booking Redis interruption crosses the 100-row reconciliation boundary. All 105 events share one submillisecond creation timestamp, exercising full-precision cursor boundaries and graceful drain. A failed first-page observation does not prevent later pages from progressing; retry/wrap revisits it after the fault is removed. Current snapshots use one shared activity read per tick, and one pending reconciliation per subscriber; queues and connections are capped.

## Measurement scope and limits

Exact `commit_observed` duration uses the committing process's monotonic clock from COMMIT return to ACK arrival, including transport, render work and return leg. Remote/recovery timing uses the **persisted** outbox creation timestamp and is labelled `pre_commit_proxy`; it includes transaction/lock/publication/recovery time. Publication never substitutes that proxy for a local origin's exact timing basis. Exact cross-node correlation is unmeasured.

Latency distributions are ACK-only. Expected deliveries, missing clients/bookings, incomplete/no-data latency, pending/finalized misses and instrumentation gaps are reported separately. Eventual ACK coverage includes late ACKs; on-time coverage excludes them. The default reporting window is 24 hours, maximum seven days, based on persisted outbox creation time with status evaluated at query time. Processing is capped at 50,000 joined rows and detail at 100 bookings/clients each; truncation/omitted counts are explicit and incomplete reports cannot pass attainment. Narrower windows may be necessary for complete reports. Large reconciliation backlogs can delay measurement recovery; indexed cursor pages and retry/wrap preserve unresolved work rather than deleting it.

Foreground/subscription eligibility is client-reported in this unauthenticated demo and captured at observation, immediately post-COMMIT for origin and at proxy observation for remote/recovery. Later hide/disconnect may interrupt rendering but does not alter the captured denominator. Snapshot receipt alone does not prove a rendered view; only the client ACK does.

Abrupt crash/heartbeat detection remains a follow-up. A proven-dead gateway requires the documented manual lifetime reconciliation; the SIGKILL/restart regression verifies it without deleting historical evidence. Broad module/refactoring work, exact distributed clocks, many-client/production capacity testing, and real browser/emulator/device visual performance remain unmeasured or deferred. Local synthetic results are not production attainment claims.

## Review

### Standards

Correction diff reviewed against `b5db45d`; independent reviewer found a submillisecond timestamp cursor bug. Fixed with a full-precision database timestamp cursor; a 105-event same-timestamp regression verifies paging and graceful drain. Re-review reports no remaining material findings.

### Spec

Correction diff reviewed against the requested live-delivery findings and PLANS.md; the independent spec reviewer could not complete because of an account usage limit. The primary agent checked the completed diff against each requested correction: cutoff/drain ordering, missing-cohort and ACK-only metrics, immutable eligibility, timing separation, delivery despite telemetry/expiry, bounded recovery/reporting, protocol integrity and documentation. No remaining material mismatch was found in this direct check. Independent spec review remains a review limitation.

## Integration with current main

Main's invitation assignment migrations retain numbers 005/006; the unmerged live migrations follow as 007/008. Shared live snapshots update availability/membership while actor-specific invitation policy remains sourced from HTTP. A delayed actor refresh combines its policy with newer live membership; ACKs wait until that actor's view renders. Two rendered regressions verify these integration boundaries. Existing invitation booking tests now provide a recovered transport snapshot. Backend test files run serially to respect local PostgreSQL connection limits; concurrency races and the 50 overlapping booking requests remain unchanged inside the tests.

The complete integration suite passes: 12 root, 81 backend and 76 web tests; typecheck and production build pass. The integration reviewer found no material findings in the conflict resolutions.
