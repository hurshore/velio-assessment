# Foundation verification

Issue #1; PLANS.md §2.1, §2.3, §2.8 and §5. Results recorded on 8 October 2026. This report covers skeleton connectivity only; it is not evidence of booking or production SLO attainment.

## Environment

macOS arm64; Node 24.21.0, npm 11.19.0; Flutter 3.47.6 / Dart 3.13.5; Docker Engine 29.7.2, Compose 5.5.1. Xcode simulator inventory includes a booted iPhone 17 on iOS 26.2. Flutter's initial device scan detected macOS/Chrome before simulator enumeration.

## Completed setup checks

- Dependency resolution with exact Node versions and lockfile: passed (temporary npm cache used because the pre-existing user cache had inaccessible files).
- `npm run setup`: generated distinct ignored local runtime/migration passwords.
- `docker compose up -d --wait`: passed; PostgreSQL 17.6-alpine and Redis 8.2.1-alpine healthy on a newly created project volume.
- `npm run migrate` twice: passed; no domain migration files in foundation, ledger bootstrap is repeatable.

## API and client checks

- TypeScript typechecking and backend/web production builds: passed.
- Focused behavior tests: HTTP liveness/readiness (5), web status/error/retry (3), Flutter status/error/retry (3): passed after their red/green slices.
- Actual browser: Codex in-app browser at `http://localhost:5173/`, Vite proxy to `http://127.0.0.1:3000/api/ready`. Rendered “API connected”, both dependencies ready, request `701ba9e8-7929-4d34-9e0c-256c95fc2d0a`. Screenshot inspected; no mock API.
- Actual iOS simulator: iPhone 17, iOS 26.2, device ID `8860318F-EE81-4AD3-86FB-0D4A368032A2`, API base `http://127.0.0.1:3000`. `flutter test integration_test/api_roundtrip_test.dart -d <device-id> --dart-define=API_BASE_URL=http://127.0.0.1:3000` built/launched the app and asserted its rendered readiness/UUID. Passed; server request `966ff122-f620-4ed5-a6ef-0445bce6acda`.
- `npm run smoke`: real HTTP health and readiness both returned 200 with the documented envelope.
- Actual dependency interruption: stopped PostgreSQL, then Redis individually in Compose. In each case liveness remained 200 and readiness returned 503 `DEPENDENCIES_UNAVAILABLE` (9ms / 3ms observed); restarting each service restored readiness to 200. Domain data was not created or altered.

## Limits

Android emulator/build and physical-device requests have not been verified. `flutter doctor -v` reports missing Android command-line tools and unknown license status. Xcode 26.2/iOS simulator verification passed. No domain functionality, production readiness, or booking SLO attainment is claimed. Final suite and review results are recorded after execution below.

## Reproducibility

A fresh copy of the staged files at `/private/tmp/velio-foundation-clean` passed `npm ci` (with the temporary cache), `npm run setup`, `npm run typecheck`, `npm run build`, and `npm run mobile:get` with locked resolution. Initial Compose startup used a new empty project volume and migration bootstrap was run twice. The second checkout did not start another Compose instance against the existing volume because its newly generated passwords differ; this is the documented persistent-volume behavior.

## Final verification and review

`npm run verify` passed: TypeScript checks, all Node behavior tests (5 HTTP + 3 web), backend/web builds, Flutter analyzer (no issues), and all 3 Flutter widget tests. The separately executed iOS integration test passed as recorded above. Generated scaffolding and later booking features were not tested.

### Standards

No material findings. The reviewer inspected the complete nonempty staged implementation against starting main `6d73c6837d5e29df48d4a637d5f01da70c669138` using `git diff --cached <baseline>`, including all 130 uncommitted files. No documented convention violations or material code smells were found.

### Spec

No material findings. The independent reviewer checked issue #1 and PLANS.md §2.1, §2.3, §2.8 and §5 against the same complete staged implementation. All foundation requirements were represented; domain features remained deferred to their owning tickets. Actual roundtrips were verified by the implementation session, not independently rerun by the reviewers.

Total findings: Standards 0; Spec 0. Review of integration remains pending in the PR; issue #1 remains In review until review, integration, and verification are complete.
