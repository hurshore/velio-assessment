# Issue #7: live availability verification

Verified locally on 8 October 2026 against PLANS.md §2.5, §2.9, §3.1–3.2 and §4.1–4.3. Node 24.21.0/npm 11.19.0, PostgreSQL 17.6 and Redis 8.2.1 in Docker, Flutter 3.47.6; macOS host. Test databases are uniquely named and removed after each run. Synthetic/test identities and host flags prevent these scenarios entering default product/live metrics.

## Executed checks

- `npm run typecheck`: backend and web pass.
- `npm test`: 12 root tests, 59 backend tests and 64 web tests pass. The backend suite includes eleven real-service live scenarios; the web suite includes six focused live-view scenarios and all 16 booking regressions.
- `npm run build`: backend TypeScript and web production build pass.
- `npm run mobile:check`: Flutter analysis finds no issues; all 13 existing tests pass. The mobile guest/live journey is outside this ticket.
- `git diff --check`: pass.

The integration suite starts two **actual API processes** sharing an isolated runtime database and real Redis. A test-owned TCP proxy drops only their Redis connections; it never stops or clears the shared Redis service. The HTTP/Redis/WebSocket boundaries exercise publication/retry, version/membership integrity, missed-delivery recovery and instrumentation. UI tests replace HTTP/WebSocket transport at the rendered-view boundary, without mocking application collaborators.

## Measured local results

| Scenario | Samples / coverage | Observed result |
|---|---|---|
| 50 overlapping bookings, one local foreground subscriber | 50 committed bookings; 50 expected/50 ACKs; 100% coverage; zero delivery misses | Per-booking maximum and per-client p95 **1229.34 ms**, maximum **1395.37 ms** in the final full-suite run |
| Forced missing ACK | One booking; two local foreground subscribers; one ACK; 50% coverage; one delivery miss | Successful sample **45.30 ms**; `everyClientTargetMet=false` despite its fast latency |
| Cross-process publication | One remote foreground subscriber/one ACK; 100% coverage | **77 ms**, explicitly `pre_commit_proxy`; excluded from exact local latency |
| Slow instrumentation + delayed ACK | One scoped 1.1-second storage delay plus 1.2-second client delay | Late ACK counts immediately as a miss; storage work cannot extend the commit-observed deadline |
| Subscription races | 12 subscribing clients and four overlapping bookings | All converge on version 5, four participants and full capacity; duplicate/reordered Redis messages do not create observations twice |
| Redis interruption/retry | One committed booking; real publisher offline, then reconnected | First publication failure persists attempt/retry state; successful retry marks dispatch on attempt 2; remote view recovers through periodic reconciliation while Redis is interrupted |
| API restart | One committed booking, deliberately unacknowledged delivery | New process restores version 2 and the same confirmation; prior connection's durable expectation remains a delivery miss |

The 50-booking check sends writes together using `Promise.all`, allowing pooled transactions to overlap behind PostgreSQL's activity lock. It measures commit-observed-to-ACK, not time waiting to book. The functional check verifies complete coverage and agreement between endpoint quantiles and independently queried storage; it reports host-dependent performance rather than treating an arbitrary busy machine as a deterministic speed assertion.

## Rendering and recovery evidence

The rendered activity test inspects the DOM **inside the WebSocket ACK send callback**: full counts, committed participant name and full-state explanation must already be present. Additional tests verify old/duplicate versions cannot replace newer state, hidden views do not ACK, foreground refresh restores membership, reconnect retains details visibly stale, a socket with no initial snapshot times out, and late callbacks from a replaced connection cannot invalidate its replacement. Existing lost-response/idempotent confirmation recovery tests still pass.

Each scenario inspects authoritative count/booking membership through activity/own-booking reads; relevant integration scenarios also inspect the independent `booking_reconciliation` view. Runtime grants are exercised throughout. No second participant list or capacity authority is introduced.

## Measurement limits

Exact local duration starts on the committing process immediately after PostgreSQL COMMIT returns and ends on that process's WebSocket ACK arrival, using its monotonic clock. It includes transport, render/application work and the return leg. One API process correlates these samples; the two-process transport demonstration does not claim exact distributed timing. Remote/recovery duration uses outbox creation time and is a **pre-commit proxy**, which can include transaction time and publication backlog. Exact cross-node clocks/correlation remain a follow-up.

Foreground/subscription context is client-reported in this unauthenticated demo. Unobserved/offline clients are not counted as successfully delivered. Durable expected deliveries survive connection loss and API restart; missing/late ACKs remain visible. Durable origin/process observation gaps disable a pass across endpoints and restarts. Historical process-local failure counts remain diagnostic. An abrupt process loss can leave a conservatively unknown lifetime; automatic crashed-process lifetime reconciliation remains a production follow-up. Browser/emulator/device visual performance was not manually measured; automated DOM tests establish rendering-before-ACK behavior, and these local synthetic results are not production attainment claims.


## Review and focused corrections

### Standards

No hard documented-standard breach. The independent review found unbounded observed-event/failed-ACK retry state (P2), plus an advisory large-module smell. Fixed: observed state now exists only for in-flight/failed persistence, expired retries retire while durable late-ACK recovery remains available, retry/connection queues have bounds, and durable measurement operations live in `live-store.ts`. A real-service regression verifies event retransmissions stop after expiry and a late ACK remains measurable.

### Spec

The independent review found subscription coverage excluded a remote client joining during a waiting transaction (P1), and failed observation writes could disappear from a different process/restarted metrics verdict (P2). Fixed: initial version boundaries replace transaction-start filtering; transactional origin metadata and durable gateway lifetimes expose missing observations; retries preserve the captured cohort/clock. Coordinated row-lock, storage-fault and restart regressions verify these cases.

Initial findings: Standards 0 hard breaches, 1 material behavior finding (P2), 1 advisory smell; Spec 2 material findings (worst P1). All original material findings are addressed. Re-review found no remaining material spec finding. Standards re-review accepts the explicit manual recovery limitation and its SIGKILL regression; no material findings remain. The abrupt-process lifetime caveat is documented below.


A SIGKILL/crash does not close its durable gateway lifetime automatically. Until an operator proves termination and reconciles only that process UUID with a verified UTC upper bound, subsequent bookings remain conservatively exposed as instrumentation gaps. The real SIGKILL/restart regression performs that explicit reconciliation, verifies future bookings add no dead-process gaps, and preserves old observation/miss evidence. The startup log provides the gateway UUID; the parameterized recovery operation is documented in the API contract. Automated fenced lifetime detection is a production follow-up, not a claim of automatic crash-metrics recovery.
