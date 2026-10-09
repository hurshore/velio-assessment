# Velio public invitation guest app

Use Flutter 3.47.6 / Dart 3.13.5. Dependencies and lockfile are pinned. Start the API and dependencies using the [root setup guide](../README.md), then:

```sh
flutter pub get --enforce-lockfile
flutter run -d <device-id> --dart-define=API_BASE_URL=http://127.0.0.1:3000
```

The guest screen accepts grouped or lowercase codes. Before identity setup it shows the inviter's name/role, public-link trust semantics, meeting place, date/time in the activity's IANA timezone, price and the latest fetched availability. Invitations reserve nothing; capacity is checked again in PostgreSQL when claiming. This slice uses fetched snapshots; live subscriptions and saved offline details belong to #9.

Choose an existing demo identity or create one after previewing. Selection is an assessment mechanism, not authentication. New identities include the invitation context so the server records acquisition. After an uncertain signup response, select the created name from the demo directory before trying another signup. The UI confirms only an authoritative booking, including the committed price and plan membership. A light success haptic follows a new confirmed claim or recovery of an unresolved claim; reopening a known confirmation does not vibrate again.

## Installed-app links

The iOS and Android app registers `velio://invite/<12-character-code>?journey=<UUID>`. A new guest session adopts the linked web journey before its first preview; a session with an existing journey keeps that journey. Neither fresh-install deferred linking nor verified HTTPS Universal/App Links is configured. After installing, enter the code manually. Cross-device code entry starts a different journey.

For an installed iOS simulator app:

```sh
xcrun simctl openurl <booted-simulator-id> 'velio://invite/<code>?journey=<UUID>'
```

Accept iOS's **Open in Velio Mobile?** prompt when shown. For Android:

```sh
adb shell am start -a android.intent.action.VIEW -d 'velio://invite/<code>?journey=<UUID>' com.velio.velio_mobile
```

See the [app_links setup](https://pub.dev/packages/app_links) for native handling. Flutter's built-in deep-link handler is disabled to give this plugin ownership. Code entry always remains available. Android configuration is included; this ticket's executed native verification uses iOS.

## Persistence and recovery

`guest-v1.json` in application-support storage contains the selected identity, code/name draft, journey, actor/code claim keys, unresolved claims, celebrated bookings and undelivered events. Writes are serialized, flushed to a temporary file, then renamed. A claim is sent only after its request key and pending state have been saved. Retry/reopen uses the same key, and own-booking lookup runs before a new claim. Restart restores the selected identity and checks its booking even if the invitation has become full or expired. During same-invitation refresh, in-memory details and an existing confirmation remain visible; stale availability is labelled and fresh claims wait for revalidation. Storage initialization errors are visible and do not silently discard the session.

Preview events are captured after a rendered frame and persisted with their original IDs, time, journey and actor context. Retrying sends the original envelope, so server deduplication remains effective after a lost response. The queue retries on opening/resume and through **Retry saved events**; tracking failure does not invalidate a booking. The server derives rail, generation and assignment. App timestamps use UTC milliseconds to match the shared API contract. HTTP requests are aborted on timeout and screen disposal; injected clients remain caller-owned.

Android emulator API: `http://10.0.2.2:3000`. iOS simulator/macOS: `http://127.0.0.1:3000`. Physical phones use the development machine's LAN address and the root guide's explicit LAN setup. HTTP exceptions are Debug-only; release devices require HTTPS and your signing configuration.

## Verification

```sh
flutter analyze
flutter test
flutter test integration_test/api_roundtrip_test.dart -d <ios-simulator-id> --dart-define=API_BASE_URL=http://127.0.0.1:3000
# From repository root, with the API running:
node scripts/check-mobile-guest.mjs <booted-ios-simulator-id>
```

The guest helper starts a real simulator integration test and opens its generated native link. Accept the iOS opening prompt promptly. It creates labelled test data, verifies preview before identity, drops a committed response, recovers the same booking, renders a graceful losing claim after another booking takes the last seat, verifies event-ID replay, and exercises code-entry fallback. It retains marked server fixtures for audit; local temporary session files are removed. The test expects invitation creation enabled and a nonzero treatment allocation. [Executed evidence and limits](../docs/verification/flutter-public-invites.md).
