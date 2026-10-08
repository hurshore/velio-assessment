# Safe seat booking verification (#3)

Scope: PLANS.md §2.2–2.4, §2.9, §3.2, §3.4 and §4.1–4.2. Booking writes and own-confirmation recovery are implemented; invitations, dispatch/subscriptions, metrics dashboards and mobile guest behavior belong to later tickets.

## Environment and results

8 October 2026, macOS, Node 24.21.0/npm 11.19.0; Compose PostgreSQL 17.6-alpine and Redis 8.2.1-alpine, both healthy. Migrations run with the migration login and the API with the separate runtime login. `003_safe_bookings.sql` applied successfully to the local database. Labelled host and started/cancelled seeds ran twice successfully without resetting existing data.

Tests use real HTTP and PostgreSQL in an isolated database per suite. The race pool permits 60 connections. Fifty distinct synthetic/test identities start together behind a held activity row; the test verifies at least ten overlapping lock waits before releasing the barrier. One-seat run: exactly 1 committed success and 49 SOLD_OUT rejections. Three-seat run: exactly 3 successes and 47 SOLD_OUT rejections. Each run inspects booking rows, counter/version, API participants, outbox and committed events; reconciliation reports no mismatch or oversell. These are local correctness checks, not a production SLO or separate available-capacity success-rate workload.

Same-key concurrency converges to one confirmation. Different keys for the same initially unbooked actor consume one seat. Actor scoping, changed-activity fingerprint rejection, lookup/original-key recovery after discarding the first response, and recovery after cancellation/start are verified. Runtime credentials cannot update/delete bookings. New claims reject started/cancelled activities; independent membership/counter mismatch refuses new allocation.

A held row exceeds the 1.5-second lock timeout and yields a retryable technical response with unknown eligibility; the failed key then succeeds after release. A database trigger injects failure at the outbox write before commit: booking, counter/version, success event, outbox and key success all roll back; attempted/eligible-failure telemetry remains. Post-commit outcome telemetry failure logs diagnostics and returns a degraded tracking warning while preserving booking confirmation. Invalid/malformed raw requests and replays have separate outcomes; actor/activity synthetic/test markers propagate.

Rendered web tests verify pending feedback without early confirmation, repeat-tap suppression, lost committed response recovery, persisted unresolved key across closing/reopening, sold-out context preservation, existing booking recovery and degraded-telemetry warning. The first booking, reconciliation and web-pending slices were observed failing before implementation; malformed-JSON raw telemetry was also observed failing before correction.

## Browser walkthrough

Codex in-app WebKit, approximately 455px-wide viewport, local Vite/API, Africa/Lagos display zone. Selected the existing Tunde synthetic seed and opened the existing free Browser verification synthetic activity. Booking confirmed with a stable booking/plan reference, changed authoritative details from two to one remaining seat and showed Tunde in confirmed participants. Reloading the browser and reopening details restored the identical booking and price snapshot. Labels, contrast, wrapping and controls were visually inspected; this is not a comprehensive assistive-technology audit. Existing development servers were reused after a second launch correctly reported the web port occupied.

## Checks

`npm run verify` passed after the raw-telemetry and settled-rejection corrections: both TypeScript checks, 12 tooling tests, 44 backend tests (15 booking and 9 activity integration cases), 52 web tests, backend/Vite production builds, clean Flutter analysis and all 13 Flutter tests. None skipped. `npm run smoke` returned 200 for health and PostgreSQL/Redis readiness. `git diff --check` passed.

## Boundaries

Completed-key replay returns the original committed availability snapshot; current details/own-booking lookup return current state. Counts are labelled snapshots until the live ticket. Pending request keys persist per actor/activity when browser storage is available; lookup still recovers membership without the original key. Demo identities are unverified, prices are display only, and no payments are collected. Attempt/failure telemetry is best effort with visible diagnostics/degraded success warnings; a telemetry outage does not invalidate committed business state. No claim of production-month reliability, live latency or product conversion attainment is made.

## Independent review

### Standards

The reviewer found one P3 documented-standard issue: the telemetry comment incorrectly said attempts run after rollback/commit. It now accurately describes attempts before the transaction and outcomes after rollback/commit; no behavioral change was needed. No other documented violations or actionable baseline smells were reported.

### Spec

The reviewer found one P2 recovery issue: definitive sold-out/started/cancelled rejection retained a pending key and could turn into uncertainty after checking/reopening. The UI now clears that pending marker and preserves rejection after an empty confirmation lookup. Four failing regressions reproduced successful and failed confirmation checks plus reopening; all pass after the correction. The reviewer rechecked the successful paths and identified the failed-lookup catch, which was corrected with the fourth regression. The final independent correction review confirmed the finding resolved with no remaining actionable Spec findings.
