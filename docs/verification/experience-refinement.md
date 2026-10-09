# Issue #27: experience refinement evidence

Executed 9 October 2026 from main `b06d3de708d16e8990c5410ea0bba00d0671c005`, in dedicated branch `feat/27-velio-experience`. The dated PLANS.md §3/§6 refinement was recorded before UI changes, preserving the original decisions. All 24 supplied PNGs (IMG_0912–IMG_0935) were individually viewed. System fonts, semantic colors and abstract activity art adapt those references without inventing activity photographs, trust scores or community totals.

## Final PR review corrections and clean demo

Use the captures in **[final-demo/](experience-refinement/final-demo/)** for the final visual review. They supersede the earlier demonstration captures below, which retain historical regression-fixture names and data.

Invitation creation now persists unresolved outcomes separately from active loading. Both public and vouch regressions cover an interrupted pending request and a lost response, three successive reloads without a new POST, and an explicit later creation that must not erase the earlier uncertainty. The vouch regression also checks contact editing. The four new regressions failed before the fix. Legacy saved `creating: true` records still restore the warning.

Host tracking is inside “Demo guidance & tracking”; guest tracking is inside “Reviewer diagnostics.” Both disclosures are collapsed by default, with an accessible attention indicator for failures/rejections. Retry continues to send the original event ID after navigation. Booking and offline messages now use “seat confirmed,” “Retry booking,” and “original booking attempt” while preserving keys, identity ownership, live readiness and online-only claiming.

### Final verification

- `npm run verify` passed: typechecks, **12 tooling + 141 backend + 112 web + 49 Flutter tests = 314**, production builds and Flutter analysis.
- After the final copy-only clarification, `npm run mobile:check` passed again: Flutter analysis and all 49 tests.
- Actual desktop web at 1440×1000 (guest previews at 1280×720), narrow web at 390×844, and iPhone 17 / iOS 26.2 captures were inspected. Full-page web images extend beyond their viewport; native images show a scrollable viewport.
- Real `web_handoff_test.dart` passed both rails against the separate demo API: preview before identity, invited signup, last-seat claim after a deliberately lost response, and remount recovering the identical booking with exactly one claim key.
- Final-tree real `live_guest_test.dart` also passed both rails on the original regression API (3104): mismatched identities, lost-response recovery, tracking event retries, live participant convergence, resume, offline confirmation and reconnect. Its regression screenshots stayed in a separate temporary folder.
- The web activity form created “Coffee, conversation & a marina walk,” with NGN 2,500 entered in normal currency units. Live web details showed both confirmed participants after native claims. Switching to the host removed the booker’s confirmation and issued link.

### Isolated demonstration data

Created and migrated a separate database, `velio_demo_27_564bdb2ef0`, with API port 3110 and Vite port 5176. Existing development/test databases and root environment files were unchanged. This demo process alone uses 100% treatment assignment to make both invitation rails deterministic; production experiment defaults and backend code are unchanged.

The initial catalog and three identities were created through the real API with readable names and `synthetic: true, test: true`. Zainab’s bookings and both invitations were created through the actual web UI. Tunde and Lola signed up through the native invited journeys and inherited those markers. A read-only audit found **5 identities and 55 analytics events, with zero unmarked records**, before the final evidence publication. The normal regression fixture was not run against this database.

| Rail | Activity | Invitation | Journey | Confirmed/recovered booking |
|---|---|---|---|---|
| Public | A slow morning by the water | `9W6MBCE16GB9` | `9b00a001-32ec-4fc3-bd58-6f442fefe5bb` | `3d7b4857-3c16-4c91-ac13-edfb544aec1e` |
| Vouch | Art, coffee & good company | `3QNBM7TB9MCS` | `573c387c-203a-4413-b276-ef4a057352fb` | `94e7c267-99de-43e2-ab1b-a0b8c6b7bf89` |

### Latest rendered screens

| Experience | Desktop web | Narrow web |
|---|---|---|
| Discovery | [Explore](experience-refinement/final-demo/web-desktop-explore.jpg), [Hosting](experience-refinement/final-demo/web-desktop-hosting.jpg) | [Explore](experience-refinement/final-demo/web-narrow-explore.jpg) |
| Activity creation | [Filled form](experience-refinement/final-demo/web-desktop-create.jpg) | [Filled form](experience-refinement/final-demo/web-narrow-create.jpg), [created detail](experience-refinement/final-demo/web-narrow-created-detail.jpg) |
| Issued invitations | [Public link](experience-refinement/final-demo/web-desktop-public-share.jpg), [personal vouch](experience-refinement/final-demo/web-desktop-vouch-share.jpg) | Same responsive panels; original task captures below also cover the choice panels |
| Guest invitation | [Public](experience-refinement/final-demo/web-desktop-public-preview.jpg), [vouch](experience-refinement/final-demo/web-desktop-vouch-preview.jpg) | [Vouch](experience-refinement/final-demo/web-narrow-vouch-preview.jpg), [full public invitation with recovery](experience-refinement/final-demo/web-narrow-public-full-recovery.jpg) |
| Host after native claims | [Confirmed participants](experience-refinement/final-demo/web-desktop-host-participants.jpg) | Same live read model |

| Native guest state | Public | Vouch |
|---|---|---|
| Preview before identity | [Preview](experience-refinement/final-demo/public-preview.png) | [Preview](experience-refinement/final-demo/vouch-preview.png) |
| Confirmed last seat | [Confirmation](experience-refinement/final-demo/public-confirmed.png) | [Confirmation](experience-refinement/final-demo/vouch-confirmed.png) |
| Same booking after remount | [Recovered](experience-refinement/final-demo/public-recovered.png) | [Recovered](experience-refinement/final-demo/vouch-recovered.png) |

### Standards

No hard violations or actionable baseline smells. The reviewer’s single wording concern was addressed in `87afd22`: an uncertain saved booking **attempt** is distinguished from a confirmed booking. Final standards review found no outstanding findings.

### Spec

No findings in the focused review from `c5b5950` through `87afd22`. Separate uncertainty, accessible diagnostics, original event/key ownership and plain recovery guidance meet the requested corrections. Clean database and screenshots are documented above. No assessment was submitted.

## Earlier owner visual review follow-up

The web wordmark now uses a small period-sized dot. Flutter keeps its existing period size and uses the same `#89CF43` mint color. Native disclosures, including Booking reference, now have a white surface and rounded outline in collapsed and expanded states, with spacing around the booking reference.

Current captures: [desktop wordmark](experience-refinement/web-logo-refinement.png), [narrow web wordmark](experience-refinement/web-narrow-logo-refinement.png), [native confirmation](experience-refinement/public-confirmed.png), [vouch confirmation](experience-refinement/vouch-confirmed.png), [native entry](experience-refinement/ios-entry.png). The older web task captures below retain the earlier larger dot; these two new web captures supersede that logo treatment. Native journey captures were refreshed from the real simulator run. Entry was captured manually with the surrounding simulator window.

Full `npm run verify` passed again (12 tooling, 141 backend, 108 web and 49 Flutter tests, typechecks, analysis and builds). Both native live/offline invitation journeys passed again. Standards and specification reviews of the cosmetic follow-up found no issues. The collapsed booking-reference outline was visually inspected; both outline states share the same theme shape. Manual expansion could not be completed because simulator interaction became unavailable.

| Follow-up rail | Activity | Journey | Confirmed booking |
|---|---|---|---|
| Public | `91d3aaf1-b69a-4c57-bd49-0199d1b0ee4e` | `5cd7ef09-39fd-4fbf-ab6b-b3d6670aa1ba` | `32f12983-387d-453a-96d3-0c1ec453de5c` |
| Vouch | `0263027d-9012-4bbe-90af-4d595323ad06` | `1649a994-5bed-4b4a-9b52-d7220b36d4d9` | `7e2d7c62-83c8-41db-ba14-3311829654e8` |

Identity-spacing follow-up: 16 px separates the heading from the first choice, and 12 px separates identity buttons. Both native captures were visually inspected: [public identity chooser](experience-refinement/public-identities.png), [vouch identity chooser](experience-refinement/vouch-identities.png). Flutter analysis and all 49 widget tests passed; both real iOS live/offline invitation journeys passed again with the capture-enabled final tree. Standards/specification review found no issues. Existing selection and pending-state behavior is preserved.

## Earlier executed validation

The three issue seams were used: rendered web UI with API/storage boundaries; Flutter widgets with API/session boundaries; and real local API/PostgreSQL/Redis/live integration. Local API used port 3104, Vite port 5175, PostgreSQL 17.6 and Redis 8.2.1. Native execution used iPhone 17 simulator, iOS 26.2.

- `npm run verify`: passed typechecks, 12 repository tooling tests, 141 backend tests, 108 web tests, production builds, Flutter analyze and 49 widget tests.
- `PORT=3104 npm run smoke`: health and readiness passed with PostgreSQL/Redis ready.
- Real iOS `integration_test/web_handoff_test.dart`: both browser-created rails recovered the committed booking after a deliberately lost claim response, with the same booking and request key after remount.
- Real iOS `integration_test/live_guest_test.dart`: both rails previewed before identity, rejected mismatched identities, claimed, retained event IDs on retry, refreshed live participants, resumed, recovered the same booking/cache offline and reconnected. Fresh anonymous full previews retained a recovery path.
- Desktop (1440×1000) and narrow web (390×844) inspected through the actual browser, including creation, navigation, identity switching, issued-link reload and valid/full guest previews. Native entry, preview, confirmation, full and offline recovery screens inspected in the simulator/captured output.

The full verification command exposed an obsolete request-ID assertion after error details moved into a disclosure. The regression now verifies visible recipient guidance and opens technical details before asserting the request ID.

## Earlier real invitation journeys

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

## Earlier rendered screens

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

## Initial implementation review

The implementation skill’s two-axis review ran against the pinned main commit.

- Standards: no hard violations; one optional duplicated bookability predicate was simplified into a named predicate and an ordered visible-activity list with a single comparison time.
- Spec: fixed the “Try another code” document reload that could discard failed view-delivery retries, and corrected older README instructions that still described minor-unit price entry. The new rendered-UI regression failed before the navigation fix and verifies retry of the identical original event after navigating to code entry. The corrected navigation was also inspected in the actual browser.

All three findings were addressed before publication. Existing recovery, live and identity tests remain behavioral assertions rather than screenshots alone.

## Limits

Android was not run for this visual pass. Creation drafts persist during navigation in the same actor/session, not browser reload. Invitation draft/result storage is best effort and scoped to actor/activity; a pending creation restored after reload warns about uncertainty instead of automatically issuing a second link because the existing API has no invitation idempotency/history lookup. A hidden old vouch link is not revoked. Fresh-install deferred linking, verified identity/contact, real payments and attendance remain outside scope. These local checks do not establish production SLOs or experiment lift. No assessment was submitted.
