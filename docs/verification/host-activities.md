# Host activity creation and inspection (#2)

Executed locally on 8 October 2026. This is evidence for the host slice, not booking concurrency, live-delivery SLOs, payments, attendance or real-user outcomes.

## Environment and automated results

macOS; Node 24.21.0; npm 11.19.0; existing Compose PostgreSQL 17.6-alpine and Redis 8.2.1-alpine. API uses the runtime login; migrations/seeds use the separate migration login. Both SQL migrations applied successfully. Seeds ran twice without replacing identities, plans or acquisition events.

- `npm run typecheck`: both TypeScript workspaces passed (also run throughout implementation).
- `npm test`: 12 tooling tests, 28 backend tests (including 8 real HTTP/PostgreSQL host-slice tests), 21 rendered React tests; all passed, none skipped.
- `npm run build`: backend and production Vite build passed.
- `npm run mobile:check`: Flutter analysis clean; all 13 existing guest-skeleton tests passed.
- `npm run smoke`: live API health and PostgreSQL/Redis readiness both returned 200.

The approved test seams were HTTP API plus real PostgreSQL, and the rendered React UI. Integration tests create an isolated uniquely named database, run actual migrations and exercise requests using runtime credentials; they clean up only their own database. They verify organic identity recovery and generation/root, invalid activity inputs, one unique plan, untouched host capacity, booking-derived participants, database constraints, runtime ancestry protections, schema/source/context validation, client-event replay/deduplication, inherited synthetic/test markers (including anonymous seed views) and seed repeatability. Controlled UI transport responses cover persistence/switching, pending creation rollback, committed creation/details, client validation, discovery loading/error/empty/retry and tracking retry with the original event ID. New slices were first observed failing, then implemented and rerun.

## Actual browser walkthrough

Codex in-app WebKit browser, local Vite `/api` proxy, device timezone Africa/Lagos, narrow approximately 540px viewport. Selected Amara (labelled synthetic seed), entered a two-seat/free NGN activity with full description and meeting place. Native date entry previewed 16 January 2030 09:00 Africa/Lagos as `2030-01-16T08:00:00.000Z`. Creation cleared the form and focused details. The list and authoritative detail showed two remaining seats, zero confirmed participants and one shared plan. Reload preserved Amara; switching to Tunde and reloading preserved Tunde. Reopened the created activity under that stable identity. Labels, focus, contrast and touch targets were visually inspected; this is not a comprehensive assistive-technology audit.

Runtime SQL inspection of this created activity confirmed capacity 2, confirmed count 0, price 0 NGN, Africa/Lagos, one plan, zero booking rows, and synthetic client-rendered activity_viewed records. Seeded signup events and API-created identity events were also inspected through real database tests.

## Boundaries

No booking writes, editing/cancellation, invitations, mobile domain flow, live subscriptions or metrics are implemented in #2. Participant reads already use confirmed booking rows; #3 extends the minimal membership schema with the authoritative transaction and grants. Display-name mutation is allowed at the database role boundary, not exposed as an editing feature. Event ingestion accepts only schema-1 client activity_viewed; identity_created is server-written atomically. View-event delivery failure is separately visible and retryable while details remain usable. Creation transport failure may follow a successful commit; users are told to refresh before retrying because activity-creation idempotency is outside this slice. Capacity is explicitly a snapshot until the live ticket.

## Review

Two independent code-review axes compared the implementation to approved baseline `7a5553c`. Standards found no documented violations; one optional duplication observation in the two short list-loading effects was retained as explicit, readable flows. Spec found no additional mismatches beyond anonymous seeded-activity views initially missing their synthetic marker. A failing regression reproduced that edge; ingestion now inherits activity-host markers as well as selected-identity markers. The focused integration suite and full checks were rerun after that correction.


## Review corrections verified

The follow-up review reproduced the lowercase-timezone insertion failure, incomplete domain-error parsing, stale documentation introductions, and view delivery cancellation on component unmount. Approved focused regressions were observed failing before correction.

- `Africa/Lagos` and `africa/lagos` both return and store `Africa/Lagos`. Real HTTP/PostgreSQL tests inspect the persisted value and database display guard, load details, and format the resulting instant. The rendered web test displays the authoritative Africa/Lagos zone and its corresponding local time after lowercase form input. Invalid zones return 400 `INVALID_REQUEST`, retryable false, with useful timezone guidance.
- Domain and readiness responses share a validator for nonempty code/message/requestId and boolean retryability. Compliant domain errors preserve those fields. Incomplete, malformed and non-JSON responses show unexpected-response retry guidance; shared readiness fixtures also exercise the domain helper.
- View delivery is app-owned and each HTTP attempt is bounded to eight seconds. Rendered tests cover closing details, changing activities, changing identity, refreshing details, StrictMode replay and actual timeout. Failed delivery remains observable after navigation; retry sends the same ID, actor header, activity/plan, journey and original occurrence time. Duplicate server receipts clear the pending entry. Success entries are removed; failures remain available for user retry.
- `npm run verify` passed: type checks, 12 tooling tests, 29 backend tests (9 real HTTP/PostgreSQL host-slice tests), 42 rendered React/HTTP-helper tests, both production builds, clean Flutter analysis and 13 Flutter tests. None skipped. Live `npm run smoke` returned 200 for both health and PostgreSQL/Redis readiness.

Browser refresh/closure is best effort. Pending and failed view delivery lives only in app memory, so it may be lost when that session ends. This correction does not add a persistent offline telemetry queue or automatic background retries.

The correction changeset was reviewed with code-review-v3: eight static criteria, React best practices, and behavioral simulation, each assigned to a dedicated reviewer (available inherited model; Sonnet was unavailable). Two minor observations—duplicated record validation and a decision-log table break—were corrected and rechecked. No actionable findings remain; verdict APPROVE. Next.js review does not apply to this Vite application. Type checks and all 42 web tests passed again after the shared-guard cleanup.
