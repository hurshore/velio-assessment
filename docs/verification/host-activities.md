# Host activity creation and inspection (#2)

Executed locally on 8 October 2026. This is evidence for the host slice, not booking concurrency, live-delivery SLOs, payments, attendance or real-user outcomes.

## Environment and automated results

macOS; Node 24.21.0; npm 11.19.0; existing Compose PostgreSQL 17.6-alpine and Redis 8.2.1-alpine. API uses the runtime login; migrations/seeds use the separate migration login. Both SQL migrations applied successfully. Seeds ran twice without replacing identities, plans or acquisition events.

- `npm run typecheck`: both TypeScript workspaces passed (also run throughout implementation).
- `npm test`: 12 tooling tests, 27 backend tests (including 7 real HTTP/PostgreSQL host-slice tests), 21 rendered React tests; all passed, none skipped.
- `npm run build`: backend and production Vite build passed.
- `npm run mobile:check`: Flutter analysis clean; all 13 existing guest-skeleton tests passed.
- `npm run smoke`: live API health and PostgreSQL/Redis readiness both returned 200.

The approved test seams were HTTP API plus real PostgreSQL, and the rendered React UI. Integration tests create an isolated uniquely named database, run actual migrations and exercise requests using runtime credentials; they clean up only their own database. They verify organic identity recovery and generation/root, invalid activity inputs, one unique plan, untouched host capacity, booking-derived participants, database constraints, runtime ancestry protections, schema/source/context validation, client-event replay/deduplication, inherited synthetic/test markers and seed repeatability. Controlled UI transport responses cover persistence/switching, pending creation rollback, committed creation/details, client validation, discovery loading/error/empty/retry and tracking retry with the original event ID. New slices were first observed failing, then implemented and rerun.

## Actual browser walkthrough

Codex in-app WebKit browser, local Vite `/api` proxy, device timezone Africa/Lagos, narrow approximately 540px viewport. Selected Amara (labelled synthetic seed), entered a two-seat/free NGN activity with full description and meeting place. Native date entry previewed 16 January 2030 09:00 Africa/Lagos as `2030-01-16T08:00:00.000Z`. Creation cleared the form and focused details. The list and authoritative detail showed two remaining seats, zero confirmed participants and one shared plan. Reload preserved Amara; switching to Tunde and reloading preserved Tunde. Reopened the created activity under that stable identity. Labels, focus, contrast and touch targets were visually inspected; this is not a comprehensive assistive-technology audit.

Runtime SQL inspection of this created activity confirmed capacity 2, confirmed count 0, price 0 NGN, Africa/Lagos, one plan, zero booking rows, and synthetic client-rendered activity_viewed records. Seeded signup events and API-created identity events were also inspected through real database tests.

## Boundaries

No booking writes, editing/cancellation, invitations, mobile domain flow, live subscriptions or metrics are implemented in #2. Participant reads already use confirmed booking rows; #3 extends the minimal membership schema with the authoritative transaction and grants. Display-name mutation is allowed at the database role boundary, not exposed as an editing feature. Event ingestion accepts only schema-1 client activity_viewed; identity_created is server-written atomically. View-event delivery failure is separately visible and retryable while details remain usable. Creation transport failure may follow a successful commit; users are told to refresh before retrying because activity-creation idempotency is outside this slice. Capacity is explicitly a snapshot until the live ticket.
