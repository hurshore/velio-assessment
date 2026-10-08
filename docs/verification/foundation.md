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

## Hardening review follow-up (issue #1)

The supplied review of commit 300b98b was checked against source before editing. Findings were reproduced at their approved seams, including the malformed web error-reference crash and mobile same-frame overlapping retries. This follow-up remains on the existing foundation branch and PR #14.

| Findings | Disposition | Change or retained limitation |
|---|---|---|
| P1, M4, M5 | Fixed | Vite proxy, smoke, and root Flutter launcher derive local API connectivity from PORT, with explicit API_BASE_URL override. WEB_ORIGIN is normalized/validated. Partial .env files are preserved byte-for-byte and missing keys are reported specifically; no credentials are replaced. |
| M1, M2, P5 | Fixed | Original migration errors survive rollback/close failures. Three-digit filenames and unique prefixes are enforced before database work. An immediate advisory try-lock plus driver/statement deadlines prevents unbounded contention. |
| M3, P7 | Fixed | Failure logs retain component, request reference where available, error name/message/code/stack, with URL credentials redacted. Shutdown cleanup catches each failure, attempts remaining resources once, clears its deadline, and reports failure via exit status. |
| P2, P3, P6 | Fixed | Allowed-origin preflight supports documented planned headers; HTTP error contract tests cover 400/404/413/500. Both client error envelopes are validated, and shared malformed/error fixtures verify matching UI behavior. |
| P9, M7 diagnostics | Fixed | Mobile checks reject same-frame overlap and guard disposed/stale results; timeout/retry tests preserve current success. Debug builds retain error type/cause/stack. |
| M6, M8, M9, P8 | Fixed | Smoke tags non-JSON failures by endpoint/status; constants stay with connectivity/readiness/messages; integration test name is platform-neutral; web timeout no longer constructs a discarded abort reason. |
| P4 | Intent documented | Newly generated config and Vite default to loopback. Existing HOST values remain untouched; LAN development is explicit and documented as trusted-network-only. |
| M7 transport cancellation | Deferred | Underlying Flutter HTTP work can outlive a visible timeout. Precise follow-up: [foundation/mobile-readiness-transport-cancellation](../contracts/api.md#mobile-transport-follow-up-m7), with cancellation/ownership and socket-release acceptance criteria at the mobile guest-flow boundary. |

### Connectivity re-verification

Used process overrides PORT=3101 and WEB_ORIGIN=http://localhost:5173/ without modifying the existing .env or database credentials. Actual in-app browser at http://127.0.0.1:5173 displayed readiness through the Vite proxy with request bb7c229d-cf5a-43e0-88d5-bcb1954f1de8. Actual iPhone 17 / iOS 26.2 simulator integration passed at http://127.0.0.1:3101 with request 0694bb7c-aae7-412f-8b26-fc808a6f0588. Smoke health/readiness returned 200 on the configured port. Real OPTIONS preflight returned 204 with normalized allowed origin and the planned header list. A real held PostgreSQL advisory lock made migration startup fail clearly in 445ms; releasing it allowed the runner to succeed.

Android/physical-device requests and transport-level mobile cancellation remain unverified as described above. Hardening final-suite and completed-diff review results follow after execution.

### Hardening final suite and completed-diff review

Final npm run verify passed: 12 tooling tests, 20 backend tests, 13 web tests, and 13 Flutter widget tests (58 total), TypeScript checks, backend/web builds, and Flutter analysis with no issues. The separate real iOS integration test passed as recorded above. Staging/review included all new implementation and test files.

Standards: 0 material findings in the complete staged diff against starting main 6d73c6837d5e29df48d4a637d5f01da70c669138, with hardening isolated against 300b98b; the final diagnostic-test addition was also reviewed. Spec: 0 material findings against the supplied review and authorized hardening scope in those same nonempty diffs, including the final diagnostic test. Neither reviewer independently reran the recorded real-client requests. Only result documentation was appended after review; no implementation changed.
