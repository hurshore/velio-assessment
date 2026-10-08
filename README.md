# Velio assessment

Runnable foundation for the Express/TypeScript API, React/TypeScript/Vite web client, and Flutter guest app. [PLANS.md](PLANS.md) is the product and technical specification. Domain bookings, invitations, live updates, and tracking are subsequent tickets; the skeletons demonstrate API readiness.

## Toolchains

Use Node **24.21.0**, npm **11.19.0** (`nvm use`), Flutter **3.47.6** with Dart **3.13.5**, and Docker with Compose v2 or later supporting `up --wait`. Node/Dart dependencies are exact in manifests and committed lockfiles. Compose pins PostgreSQL **17.6-alpine** and Redis **8.2.1-alpine**. Flutter's generated Gradle/Xcode platforms retain their own tooling; iOS requires Xcode, macOS, and simulator runtimes. Android requires its SDK/emulator. No production service credentials are committed.

## Clean checkout setup

```sh
npm ci
npm run setup
npm run mobile:get
npm run infra:up
npm run migrate
npm run dev
```

`setup` creates an ignored `.env` with different random migration/runtime passwords, preserving existing configuration. See [.env.example](.env.example) for names. Compose reads root `.env`; backend commands load it explicitly. Local dependency ports bind only to loopback. PostgreSQL creates the runtime login on first initialization; it cannot create schema objects. Feature migrations grant domain access explicitly. Redis is local-only and unauthenticated. Never use this local setup for production.

The migration runner creates its ledger and applies numbered SQL files once, under an advisory lock and per-file transactions. There are no domain migrations or seeds yet; add these with their owning feature tickets. Run migrations with `MIGRATION_DATABASE_URL`, API with `DATABASE_URL` only. [Migration notes](backend/migrations/README.md).

Existing database volumes retain their original passwords. Changing `.env` does not change roles in a volume. Preserve existing data or reset deliberately with `docker compose down -v` (deletes the local database), then start again. If ports 5432/6379 are occupied, stop the conflicting local service or update Compose mappings and the matching URLs together.

## Start and verify

`npm run dev` starts API and web together; Ctrl-C stops both. Separately use `npm run dev:backend` and `npm run dev:web`. Web: <http://localhost:5173>; API liveness: <http://127.0.0.1:3000/api/health>; dependency readiness: <http://127.0.0.1:3000/api/ready>. The web screen requests `/api/ready` through Vite's `/api` proxy, including when opened over a LAN address. It shows loading, readiness, and retry states.

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

Or `npm run mobile:run` and select a local target. The default is `http://127.0.0.1:3000` for iOS simulator/macOS. Android emulator uses `--dart-define=API_BASE_URL=http://10.0.2.2:3000`. A physical phone uses `http://<Mac-LAN-IP>:3000` on the same network; allow inbound API traffic in the host firewall and grant iOS local-network access. `HOST=0.0.0.0` enables this development access. Loopback on a phone refers to the phone itself.

Android cleartext HTTP and iOS local networking exceptions are limited to Debug configurations. Use HTTPS for release mobile targets. macOS includes outbound network entitlement. Physical iOS devices require your own signing team; no developer team is embedded in the project. The screen calls readiness on launch and on retry and displays the server request reference. No emulator networking assumption substitutes for an actual request; [verification evidence](docs/verification/foundation.md) records tested targets and limits.

## Shared boundaries

- `backend/`: Express API and SQL migration runner, node-postgres and Redis connections.
- `web/`: React/Vite host/booker skeleton, npm workspace.
- `mobile/`: Flutter guest skeleton, its own Dart dependencies/commands.
- `docker-compose.yml`: PostgreSQL/Redis with health checks.
- [Initial shared contracts](docs/contracts/api.md): envelopes/errors, identity/idempotency, rail/ancestry, journey/events, versioned availability. Health routes exist now; domain routes/events arrive with their owning tickets.

Process health remains 200 during dependency outages; readiness returns a safe retryable 503. Probes are bounded and API responses do not disclose dependency credentials. Booking correctness, domain schema/grants/seeds, immutable attribution, Redis-backed live delivery, cache/haptics, metrics, and `OWNERSHIP.md` remain in subsequent plan tickets.
