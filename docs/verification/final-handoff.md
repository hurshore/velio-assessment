# Final assessment verification (#12)

Executed 9 October 2026 (Africa/Lagos), against PLANS.md §§2.9, 3.3–3.5, 4.1–4.4 and 5. All actors below are labelled synthetic/test. These are local correctness and instrumentation checks, not production-month SLOs, real-user conversion results or causal lift. Attendance is unmeasured.

## Environment and repeatable startup

macOS, Node 24.21.0/npm 11.19.0, Flutter 3.47.6/Dart 3.13.5, iPhone 17 simulator on iOS 26.2, PostgreSQL 17.6-alpine and Redis 8.2.1-alpine in Docker. The ticket worktree started clean at merged commit `5eabea4`. `npm ci`, `npm run setup`, `npm run mobile:get`, infrastructure startup, migration, seed twice, API/web launch and smoke checks were executed.

The existing development volume retained its original credentials. Fresh setup generated different credentials, so the first migration failed authentication; reusing the existing ignored environment file preserved the data and `npm run migrate` applied **012_metrics_views.sql** normally. No manual application of migration SQL was used.

A separate clean source export of `5eabea4` under `/tmp/velio-handoff-clean` then ran `npm ci`, `npm run setup` and `npm run mobile:get` with newly generated credentials. A new Compose project/volume (`velio-handoff-clean`) used PostgreSQL/Redis ports 55432/56379 so the existing stack stayed intact. Its URLs were changed to those ports. Isolation override:

```yaml
services:
  postgres:
    ports: !override
      - "127.0.0.1:55432:5432"
  redis:
    ports: !override
      - "127.0.0.1:56379:6379"
```

```sh
COMPOSE_FILE=docker-compose.yml:/tmp/velio-handoff-ports.yml COMPOSE_PROJECT_NAME=velio-handoff-clean npm run infra:up
npm run migrate
npm run seed
npm run seed
PORT=3103 WEB_ORIGIN=http://localhost:5174 npm run dev:backend
PORT=3103 npm run dev --workspace web -- --port 5174
PORT=3103 npm run smoke
```

All twelve migrations applied in order to the fresh volume. The migration role reads the ledger; the runtime role successfully reads `metric_invite_open_units` and reconciliation. The runtime role intentionally cannot read `schema_migrations`. Starting the combined dev command while port 5173 was occupied exited cleanly; separate documented launch commands with a Vite port override resolved that local conflict. Both health/readiness probes then returned 200. Original-stack API/web ports were 3102/5173.

The historical seed window (2026-09-01..09-08, `includeTest=true`) matched [the hand-calculated demonstration](product-metrics.md): reliability S=1/F=0/U=1, eligible rate 1 and conservative rate 0.5; bookers 1/7; headline conversion 3/7, eligible 3/6; public K 1/activated 0.5 and vouch K 0.5/activated 0.5; holdout treatment two participants versus control one across two activities. Reconciliation had zero violations. The inspection artifact includes native activities added after seeding, so its global activity count exceeds the 13 seeded activities. The seed smoke suite independently applies all seeds twice to an empty test database and checks exactly 13 consistent activities.

## Web → Flutter → live web demonstration

Through the actual browser UI, selected `Kemi · demo seed`, created two future two-seat activities, booked one seat in each, and issued a vouch and public link. Browser observers remained open throughout native claims. `web_handoff_test.dart` entered those exact codes, rendered previews, created invite-acquired identities (matching the vouch's demo contact), discarded each committed HTTP response, recovered confirmation, and reopened without another claim. Both web observers showed **0 of 2 seats remaining · 2 confirmed**, Kemi and their native guest, while still live-connected; no manual refresh was used.

| Rail | Web-created activity | Code | Native booking |
|---|---|---|---|
| Vouch | `4284f5d2-1fbe-4706-9b0a-99172fb38e40` | `J4XS8YRY7TWK` | `2ce4d11d-58f0-4cef-9fc0-31eb8cb9274a` |
| Public | `85eafa17-5f02-44e8-807f-e7798e226486` | `FHWVJ3R1V05P` | `a6617fa4-2acc-4080-b392-ff07c09ca804` |

The separate native `public_guest_test.dart` passed installed-app opening, code entry, lost-response recovery and the graceful losing claim (activity `3b41d615-30f8-4832-b76e-0cad0e40c33d`). `live_guest_test.dart` passed both rails with live participants, matching/rejected vouch identities, background/resume, disk-session reconstruction with HTTP/WebSocket connectivity disabled, saved confirmation/participants and reconnect without rebooking. Background/resume is injected through Flutter's binding and offline transport is deliberately disabled: these checks do not prove OS process eviction or physical network loss. Native iOS was executed; Android and physical devices were not.

Run the native commands in [README](../../README.md#reviewer-demonstration-and-final-verification), with fresh codes for the web handoff. These executed simulator runs each passed. The real live/capacity service tests additionally interrupt Redis through a TCP proxy and restart API processes.

## Real Flutter events through the actual metric queries

`handoff_metrics_test.dart` ran against the fresh isolated API (3103). Cohort: `4cf9d3db-d863-4950-b103-5a5234ec8c4c`; all fixtures are test-marked, inherited by invite signups and server events. It used real `app_links` routes opened via `simctl openurl` for **each rail**, plus typed-code entry for each rail. An anonymous rendered preview led to identity creation and an attributed committed claim. SQL inspection verified mobile platform, test markers, persisted activity/plan/booking/invite/journey references, generation 1, inviter/root and treatment assignment. Each guest has one signup, redemption, `booking_succeeded` and `spot_claimed`; the latter two represent the same committed booking rather than two successes.

Every scenario queried `/api/metrics/summary` and `/api/metrics/product` before/after replay and recovery. Re-ingesting the original Flutter open event returned `accepted:false`. A same-key retry returned the original booking and a replay outcome. Re-rendering retained the original `(invite, journey)` unit. Fresh journeys reopening the same confirmation and a different invitation on that activity remained recovery traffic. No extra seat, signup, redemption, acquisition or logical committed success appeared, and existing attribution was retained.

| Checkpoint | Committed requests | Replays | Logical successes | Immature opens / converted |
|---|---:|---:|---:|---:|
| Public link, before → after retry/reopens | 2 → 2 | 0 → 1 | 2 → 2 | 1/1 → 1/1 |
| Public code | 4 → 4 | 1 → 2 | 4 → 4 | 2/2 → 2/2 |
| Vouch link | 6 → 6 | 2 → 3 | 6 → 6 | 3/3 → 3/3 |
| Vouch code | 8 → 8 | 3 → 4 | 8 → 8 | 4/4 → 4/4 |

After waiting for real three-minute activity-start deadlines (no future reporting cutoff or timestamp rewriting), headline and eligible conversion both reported **4/4**, split public 2/2 and vouch 2/2, all mobile, inviter generation 0. Eight fresh confirmation journeys were recovery opens, excluded from rates. The result correctly remains `insufficient_sample` against 200 mature journeys. Default `includeTest=false` showed no conversion data and zero committed requests from this cohort.

K used the fixed start cohort of 13 existing eligible seed/test host/bookers, including non-inviters: each rail acquired/activated two users (2/13 each), unchanged by recovery. The few-minute window correctly says `partial_window`, not a completed seven-day result. Booker-to-inviter correctly has no mature 24-hour rate: five qualifying bookers, one inviter, all not yet mature. Holdout includes assigned controls with zero participation, four formed treatment plans, and explicitly unmeasured attendance. These deliberately constructed outcomes demonstrate query linkage, not product lift.

Full before/after counts, final query output, persisted attribution and event references are in [the machine-readable evidence](final-handoff.json). An earlier run shared a database with concurrent browser writes and changed its denominator; the accepted run used the isolated API with no other writers. Run this cohort test exclusively.

## Capacity, reliability, latency and interruptions

The serial focused service suites passed 74 tests. Real pooled transactions with coordinated starts/lock-wait inspection produced 1 success + 49 sold-out outcomes for one seat and 3 + 47 for three seats. Direct/public races, same/different keys, recipient races, vouch/public recovery, pre-commit rollback, runtime history guards and stored row/count/participant reconciliation passed. The documented runner uses `--test-concurrency=1` across files while the requests inside race tests overlap; running all heavyweight files concurrently initially produced two technical failures, so that invocation is not the reported passing run.

Separate available-capacity workload: 50 distinct test actors, 50 seats, 50 simultaneous HTTP requests to one real API origin with another API process active; one foreground protocol observer ACKs every booking update. These ACKs measure a Node protocol observer, not native frame-render latency. No requests were excluded: 50 committed, S=50/F=0/U=0, zero replays/invalid/sold-out outcomes and reconciled 50 participants. Reliability remains `insufficient_sample` against 1,000 intents.

| Measurement | Result |
|---|---:|
| Request launch-to-last-response elapsed | 1,457.43 ms |
| HTTP request p50 / p95 / max | 1,251.00 / 1,398.06 / 1,452.98 ms |
| Commit-observed-to-ACK per-booking p95 / max | 1,159.32 / 1,213.75 ms |
| Expected / acknowledged / missed deliveries | 50 / 50 / 0 |
| Eventual and on-time ACK coverage | 100% / 100% |

The test captures elapsed/HTTP timings with the Node process monotonic clock; live timings correlate COMMIT return and ACK arrival on the originating gateway's monotonic clock. A remote gateway/recovered outbox uses the separately labelled pre-commit proxy. Samples from the two timing bases are not pooled. The live analysis threshold now explicitly reports `observed` at 50 booking updates with subscribers. Zero-demand observations do not count; missing/pending deliveries do count in that sample and remain in coverage. A small fast sample cannot override a miss or instrumentation gap.

The interruption suite passed Redis publication retries and periodic snapshot recovery, API restart, duplicate/old snapshots, observation/ACK-storage failures and late/missing ACK retention. Its deliberate missing-ACK case reports coverage 1/2 and attainment false even though the one received ACK was fast. Offline/hidden clients are outside capture; foreground subscribers that disappear after capture retain their expected deliveries.

## Ownership and implemented measurement cross-check

| Proposed measurement | Final implemented definition / limitation |
|---|---|
| Available-booking guardrail | Logical intents S/(S+F), companion S/(S+F+U), replay exclusion, raw outcomes/retries retained; 99.5% and 1,000-intent trigger. No reliability confidence interval is implemented. |
| Live guardrail | Two-second per-booking maximum ACK p95 plus coverage/misses; explicit 50-update analysis status now implemented. Exact/proxy groups remain separate; recurring-failure exceptions require operational judgement. |
| Booker invitation target | First in-window booking per user, same-activity invite within 24h, mature windows, hosts without bookings separate; 30% / 200 mature journeys and Wilson interval. |
| Invitation conversion | Earliest effective `(invite, journey)` open clamped to creation/receipt; five-minute skew tolerance; earlier of 24h/start; recovery excluded, full/expired human opens retained in headline; 25% / 200 mature units. Wilson interval is on eligible conversion, not headline. |
| K and activation | Same eligible cohort fixed at seven-day start, direct frozen-rail acquisition, redemption-based activation, returning users/deeper descendants excluded from direct K. No K target or K interval. |
| Holdout and experiment | All assigned activities including unexposed/zero-participant controls; participants fixed at window end, >=2 provisional formation; Welch-style participant-difference interval when both arms have >=2 activities. Descriptive only. The proposed activity-clustered guest-UX experiment/interval is not implemented. |
| Diagnosis and long experiments | Eligible-open rail/platform/generation/new-returning segments exist; headline segments, recorded entry/loading/identity-stage funnels and >7-day reporting require further instrumentation/SQL. OWNERSHIP states these limits. |

OWNERSHIP remains a concise one-page proposal (615 words), explicitly hypothetical. Its wording now names logical-intent replay exclusions and effective-open/skew rules. No actual-user results, causal lift or numerical K target are claimed.

## Checks, corrections and remaining limits

`npm run verify` passed: tooling 12/12, backend 141/141, web 104/104 and Flutter 48/48, with backend/web typechecks and builds and Flutter analysis. Typechecking was run throughout; focused metrics tests passed 18/18, focused capacity/recovery 74/74 and the added workload passed. Native tests passed all four demonstration seams described above. The focused isolated workload supplies the measurements above; the full-suite workload also passed (50 requests and ACKs, zero misses, live p95 1,171.33ms), but its broader reporting window contained seven other tests' observed updates, so it is not used as the isolated sample.

The first full run found two fragile test setups under concurrent native builds: a 700ms expiry window included creating another identity, and a reconciliation-pagination fixture issued 25 contending writes per batch despite testing pagination. Both passed in isolation. Expiry now changes fixture state explicitly between pre/post checks; pagination still verifies all 105 updates beyond the 100-row boundary using five-write batches. Required coordinated capacity races and production deadlines are unchanged. Focused corrected checks passed.

Retained limits: client clock skew inside clamping bounds; late-ingested opens can change earlier reports; uncorrelated cross-device journeys without a shared ID; the full-history open scan exceeds the 1.5s deadline near 2.5M events (retryable `/api/metrics/product` 500; window pruning or an ingestion-maintained unit table remains follow-up); local timing/hardware and synthetic cohorts; unverified demo contacts, no payment, installed-app-only custom links; automatic crash-lifetime reconciliation, production monitoring and properly powered experiments remain follow-ups. Attendance and optional polish remain excluded.
