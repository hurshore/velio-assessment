# Issue #27: experience refinement evidence

Executed 9 October 2026 from main `b06d3de708d16e8990c5410ea0bba00d0671c005`, in dedicated branch `feat/27-velio-experience`. The dated PLANS.md §3/§6 refinement was recorded before UI changes, preserving the original decisions. All 24 supplied PNGs (IMG_0912–IMG_0935) were individually viewed. System fonts, semantic colors and abstract activity art adapt those references without inventing activity photographs, trust scores or community totals.

## Executed validation

The three issue seams were used: rendered web UI with API/storage boundaries; Flutter widgets with API/session boundaries; and real local API/PostgreSQL/Redis/live integration. Local API used port 3104, Vite port 5175, PostgreSQL 17.6 and Redis 8.2.1. Native execution used iPhone 17 simulator, iOS 26.2.

- `npm run verify`: typechecks, repository tooling tests, backend tests, web tests, production builds, Flutter analyze and widget tests.
- `PORT=3104 npm run smoke`: health and readiness passed with PostgreSQL/Redis ready.
- Real iOS `integration_test/web_handoff_test.dart`: both browser-created rails recovered the committed booking after a deliberately lost claim response, with the same booking and request key after remount.
- Real iOS `integration_test/live_guest_test.dart`: both rails previewed before identity, rejected mismatched identities, claimed, retained event IDs on retry, refreshed live participants, resumed, recovered the same booking/cache offline and reconnected. Fresh anonymous full previews retained a recovery path.
- Desktop (1440×1000) and narrow web (390×844) inspected through the actual browser, including creation, navigation, identity switching, issued-link reload and valid/full guest previews. Native entry, preview, confirmation, full and offline recovery screens inspected in the simulator/captured output.

The full verification command exposed an obsolete request-ID assertion after error details moved into a disclosure. The regression now verifies visible recipient guidance and opens technical details before asserting the request ID.

## Both real invitation journeys

| Run | Rail | Activity | Journey | Confirmed booking |
|---|---|---|---|---|
| Browser creation → iOS recovery | Public | `9da20401-c2ee-4e26-9a51-ee1134e204c5` | `c8099e23-b269-4840-825d-a72c3a27318b` | `a9e1e843-89a2-4b48-ab9e-3875b12ea512` |
| Browser creation → iOS recovery | Vouch | `573d3b4e-c948-47c3-bd31-6d8bd3db3ebe` | `06ef0796-2f53-465f-9b64-b2977a8be6ad` | `b3c486f5-647e-4888-b8c2-2d908bf2c721` |
| Final native live/offline | Public | `70147080-2f87-403e-8345-64fbeaa0341c` | `f97f74be-6ce5-4651-8df3-20638a2782b0` | `52f5be06-19a0-43c1-98ad-09fe76d2adb1` |
| Final native live/offline | Vouch | `58ac669e-f1a8-4469-8ef8-6d7f90f9fb71` | `b1470160-7057-40f3-baf5-527cbb86e84b` | `e5603595-19c0-4ae7-b1ba-1d895ff082c7` |

The first pair used real browser-created links and journey IDs. The final pair used the integration fixture against the real API, database and live gateway, with friendly activity names for readable screenshots. Native screenshots are exported by `test_driver/screenshots.dart`; they are evidence, not pixel assertions. Reproduce with an available simulator ID:

```sh
cd mobile
VELIO_SCREENSHOT_DIR=build/review-screenshots flutter drive \
  --driver=test_driver/screenshots.dart \
  --target=integration_test/live_guest_test.dart \
  -d <simulator-id> --dart-define=API_BASE_URL=http://127.0.0.1:3104
```

## Rendered screens

| Task/state | Desktop web | Narrow web |
|---|---|---|
| Explore | [Explore](experience-refinement/web-explore.jpg) | [Explore](experience-refinement/web-narrow-explore.jpg) |
| Creation | [Grouped form and preview](experience-refinement/web-creation.jpg) | [Creation](experience-refinement/web-narrow-creation.jpg) |
| Detail/invitation choice | [Choice cards](experience-refinement/web-invitation-choices.jpg) | [Choice cards](experience-refinement/web-narrow-invitation-choices.jpg), [detail](experience-refinement/web-narrow-detail.jpg) |
| Issued invitations | [Public](experience-refinement/web-public-result.jpg), [vouch](experience-refinement/web-vouch-result.jpg) | Results use the same responsive layout |
| Guest preview | [Valid](experience-refinement/web-guest-preview.jpg), [full with recovery](experience-refinement/web-guest-full.jpg) | [Valid](experience-refinement/web-narrow-guest-preview.jpg) |
| Live update after native claim | [Applied participants/counts](experience-refinement/web-live-after-native.jpg) | Same live read model |

| Native state | Public | Vouch |
|---|---|---|
| Preview before identity | [Preview](experience-refinement/public-preview.png) | [Preview](experience-refinement/vouch-preview.png) |
| Committed/recovered confirmation | [Confirmed](experience-refinement/public-confirmed.png) | [Confirmed](experience-refinement/vouch-confirmed.png) |
| Full, with existing-booking recovery | [Full](experience-refinement/public-full.png) | [Full](experience-refinement/vouch-full.png) |
| Offline recovered booking | [Offline](experience-refinement/public-offline-recovered.png) | [Offline](experience-refinement/vouch-offline-recovered.png) |

[Native code entry](experience-refinement/ios-entry.png). Screenshots preserve actual data; older synthetic activities/identity suffixes remain visible in browser fixtures. Full-page browser captures can be taller than the viewport. Native captures show the scrollable viewport, not all content at once.

## Limits

Android was not run for this visual pass. Creation drafts persist during navigation in the same actor/session, not browser reload. Invitation draft/result storage is best effort and scoped to actor/activity; a pending creation restored after reload warns about uncertainty instead of automatically issuing a second link because the existing API has no invitation idempotency/history lookup. A hidden old vouch link is not revoked. Fresh-install deferred linking, verified identity/contact, real payments and attendance remain outside scope. These local checks do not establish production SLOs or experiment lift. No assessment was submitted.
