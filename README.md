# Velio assessment

Runnable Express/TypeScript API, React/TypeScript/Vite host/booker web client, and Flutter guest skeleton. [PLANS.md](PLANS.md) is the product and technical specification. The web supports persistent organic demo identities, activity creation/discovery/details, committed seat booking/recovery, and durable rendered-view events. Invitations, live updates and metrics remain subsequent tickets.

## Toolchains

Use Node **24.21.0**, npm **11.19.0** (`nvm use`), Flutter **3.47.6** with Dart **3.13.5**, and Docker with Compose v2 or later supporting `up --wait`. Node/Dart dependencies are exact in manifests and committed lockfiles. Compose pins PostgreSQL **17.6-alpine** and Redis **8.2.1-alpine**. Flutter's generated Gradle/Xcode platforms retain their own tooling; iOS requires Xcode, macOS, and simulator runtimes. Android requires its SDK/emulator. No production service credentials are committed.

## Clean checkout setup

```sh
npm ci
npm run setup
npm run mobile:get
npm run infra:up
npm run migrate
npm run seed       # optional, labelled synthetic hosts and paid/free activities
npm run dev
```

`setup` creates an ignored `.env` with different random migration/runtime passwords only when the file is absent. For an existing file it preserves every byte and reports missing/blank required keys with a nonzero exit. Fill only those entries using `.env.example`, with the credentials already configured in PostgreSQL; do not regenerate passwords for an existing volume. See [.env.example](.env.example) for names. Compose reads root `.env`; backend commands load it explicitly. Local dependency ports bind only to loopback. PostgreSQL creates the runtime login on first initialization; it cannot create schema objects. Feature migrations grant domain access explicitly. Redis is local-only and unauthenticated. Never use this local setup for production.

The migration runner creates its ledger and applies numbered SQL files once, under an advisory lock and per-file transactions. Domain migrations establish organic identities, immutable acquisition history, activities, one shared plan, confirmed bookings, scoped idempotency results, availability outbox, and durable events. `RUNTIME_DB_USER` selects the existing runtime role receiving explicit grants. `npm run seed` uses migration credentials to add two visibly labelled synthetic hosts and paid/free and started/cancelled activities; replaying it keeps their IDs/plans/events stable and preserves existing data. Run migrations with `MIGRATION_DATABASE_URL`, API with `DATABASE_URL` only. [Migration notes](backend/migrations/README.md).

Existing database volumes retain their original passwords. Changing `.env` does not change roles in a volume. Preserve existing data or reset deliberately with `docker compose down -v` (deletes the local database), then start again. If ports 5432/6379 are occupied, stop the conflicting local service or update Compose mappings and the matching URLs together.

## Start and verify

`npm run dev` starts API and web together; Ctrl-C stops both. `PORT` controls the API listener and the Vite proxy target, smoke checks, and `npm run mobile:run`. Local tooling can override its target with `API_BASE_URL` (an HTTP(S) origin); this does not change the API listener. `WEB_ORIGIN` is validated as one HTTP(S) origin and normalized (including a trailing slash). Paths, userinfo, query strings, and fragments are rejected. Separately use `npm run dev:backend` and `npm run dev:web`. Web: <http://localhost:5173>; API liveness: <http://127.0.0.1:3000/api/health>; dependency readiness: <http://127.0.0.1:3000/api/ready>. The web screen requests `/api/ready` through Vite's `/api` proxy, including when opened over a LAN address. It shows loading, readiness, and retry states.

```sh
npm run smoke       # actual HTTP checks; requires running API and dependencies
npm run typecheck
npm test
npm run build
npm run mobile:check
npm run verify      # typecheck, Node tests, builds, Flutter analyze/tests
```

`npm run infra:down` stops dependencies and preserves the volume. `npm run build` outputs API `backend/dist` and web `web/dist`; `npm start --workspace backend` starts the built API. Web production hosting must proxy `/api` to the backend or set `VITE_API_BASE_URL` at build time and configure `WEB_ORIGIN` to the exact served origin. The foundation does not deploy a production server.

## Flutter simulator/device URLs

```sh
flutter devices
cd mobile
flutter run -d <device-id> --dart-define=API_BASE_URL=http://127.0.0.1:3000
```

Or `npm run mobile:run -- -d <device-id>`: the root helper reads `.env`, derives the URL from `PORT`, and honors an explicit `API_BASE_URL`. Direct `flutter run` has no access to root `.env`, so supply `--dart-define` when using a nondefault port/target. The default is `http://127.0.0.1:3000` for iOS simulator/macOS. Android emulator uses `--dart-define=API_BASE_URL=http://10.0.2.2:3000`. A physical phone uses `http://<Mac-LAN-IP>:3000` on the same network; allow inbound API traffic in the host firewall and grant iOS local-network access. `HOST=0.0.0.0` explicitly enables API LAN access. New setup files and both servers default to loopback; existing `.env` settings are preserved. Loopback on a phone refers to the phone itself.

Android cleartext HTTP and iOS local networking exceptions are limited to Debug configurations. Use HTTPS for release mobile targets. macOS includes outbound network entitlement. Physical iOS devices require your own signing team; no developer team is embedded in the project. The screen calls readiness on launch and on retry and displays the server request reference. No emulator networking assumption substitutes for an actual request; [verification evidence](docs/verification/foundation.md) records tested targets and limits.

## Local versus LAN development

Default new configuration uses `HOST=127.0.0.1` and `WEB_HOST=127.0.0.1`. The iOS simulator/macOS use the host loopback address. Existing configuration from the initial foundation may use `HOST=0.0.0.0`; keep it only if LAN access is intended. To check a different API port without editing credentials:

```sh
PORT=3101 npm run dev
PORT=3101 npm run smoke
PORT=3101 npm run mobile:run -- -d <ios-simulator-id>
```

For a physical phone, opt in with `HOST=0.0.0.0 npm run dev` and `API_BASE_URL=http://<Mac-LAN-IP>:<PORT> npm run mobile:run -- -d <device-id>`. Browser access from another machine also requires `WEB_HOST=0.0.0.0`; its same-origin `/api` calls still use the Vite proxy. These unauthenticated development servers should be reachable only on a trusted local network. PostgreSQL/Redis remain loopback-bound. A directly cross-origin web build uses `VITE_API_BASE_URL` in `web/.env.local` (or at build time) and a matching normalized `WEB_ORIGIN` at the API; the latter allows only that origin. Restart dev servers after changing root environment settings.

## Shared boundaries

- `backend/`: Express API and SQL migration runner, node-postgres and Redis connections.
- `web/`: React/Vite demo identity and host activity flow, npm workspace.
- `mobile/`: Flutter guest skeleton, its own Dart dependencies/commands.
- `docker-compose.yml`: PostgreSQL/Redis with health checks.
- [Initial shared contracts](docs/contracts/api.md): envelopes/errors, identity/idempotency, rail/ancestry, journey/events, versioned availability. Health, organic identity, activity discovery/creation/details and narrow rendered-view ingestion routes exist now.

Process health remains 200 during dependency outages; readiness returns a safe retryable 503. Probes are bounded and API responses do not disclose dependency credentials. Invite ancestry, Redis-backed live delivery, mobile cache/haptics, metrics, and `OWNERSHIP.md` remain in subsequent plan tickets. Booking evidence is in [the booking report](docs/verification/seat-booking.md). Host activity evidence is in [the slice verification report](docs/verification/host-activities.md).

## Create and inspect an activity

Open the web, select a seeded demo host or create an organic identity, and fill the activity form. The selection and anonymous journey survive reload in browser storage; identities themselves persist in PostgreSQL. Demo identity selection is not production authentication. Date/time entry uses the explicitly labelled device timezone; the IANA display timezone previews the same absolute instant. Capacity is a positive integer. Prices use non-negative minor units and an explicit currency (no payment).

Creation shows a pending discovery row, then authoritative details with its shared plan, remaining seats and booking-derived participants. Rejection removes the pending row and preserves inputs. After an uncertain network response, refresh discovery before retrying. Counts are labelled server snapshots; use Refresh details until live updates arrive. Hosting alone consumes no seat.

`npm test` includes real HTTP/PostgreSQL tests. They load the ignored root `.env`, create a uniquely named temporary database using the migration role, exercise the API with runtime credentials, and drop only that test database. PostgreSQL must be running and the migration login needs local CREATEDB permission (Compose's bootstrap login has it). To run just this seam: `node --env-file=.env --import tsx --test backend/test/activities.test.ts`. UI seam: `npm run test --workspace web -- --run src/HostApp.test.tsx`.

Rendered activity views keep their captured event ID, actor and time through in-app navigation and identity changes. Each delivery attempt has an eight-second deadline; failed delivery remains visible with a retry for the original view. Browser refresh/closure is best effort: pending or failed delivery is held only in memory, without a persistent offline telemetry queue.

## Book and recover one seat

Open activity details under a selected demo identity. Book one seat shows pending feedback until PostgreSQL commits; confirmation includes the booking, shared plan and snapshotted price. The API serializes capacity decisions with an activity row lock, a 1.5-second lock timeout, and unique user/activity membership. Booking, count/version, success event, idempotency result and availability outbox commit together. Redis delivery arrives in #5; refresh details for current participants/counts.

Own-booking lookup restores the same confirmation after reopening, including a full or cancelled activity. An uncertain response triggers lookup; unresolved requests retain their actor/activity key in browser storage and offer check/retry with that same key. The losing last-seat claimant keeps their details and receives a sold-out explanation. Storage failure is visible; selecting the same identity still permits server recovery. No payment is collected.

Focused verification: `node --env-file=.env --import tsx --test backend/test/bookings.test.ts` and `npm run test --workspace web -- src/SeatBooking.test.tsx`. A read-only `booking_reconciliation` SQL view compares confirmed rows to stored counts and detects overselling independently. New allocations refuse a mismatched counter. Local tests include 50 coordinated overlapping requests against one and three seats and pre-commit rollback injection. Attempt/failure/raw outcome telemetry is outside the business transaction and failures are logged; degraded telemetry on a successful response is shown without invalidating confirmation.

### Invitation rollout

`group_invites_v1` assigns each activity once, using a deterministic hash of experiment
name, version and activity UUID. New activities snapshot `INVITE_EXPERIMENT_VERSION`
(default `1`) and `INVITE_TREATMENT_PERCENT` (default `50`, integer 0–100). Configuration
changes or restarts affect only new activities. Migration 005 backfills existing
activities with version 1 at 50%, without inventing exposure events. Allocation is a
cohort setting, not a guarantee that a small sample will contain that exact percentage.

`INVITE_CREATION_ENABLED=false` disables new creation in all groups. Restart the API
after changing environment settings. Both groups can still book; future invitation
resolution/claim routes must honor issued valid codes independently of this switch.
Upcoming public/vouch creation routes must enforce `requireInviteCreation`, including
host routes. Sharing endpoints arrive in those tickets; this ticket exposes the policy,
stable assignment and displayed experience tracking.

Safety stages are internal correctness/delivery checks, a limited eligible-activity
cohort, then expanded treatment with a retained ordinary-booking holdout. A production
90/10 cohort needs sample-size assessment before adoption. Keep the version/allocation
fixed within a cohort; do not reinterpret existing assignments when rollout changes.
Compare all assigned activities in fixed windows, including those without exposure,
on participants and the provisional two-person formed-plan threshold. Attendance is
still unmeasured, and cross-activity social spillovers remain a limitation. A no-invite
holdout cannot measure invitation open-to-claim conversion; that needs a separate guest
experience comparison with invitations enabled in both groups.
