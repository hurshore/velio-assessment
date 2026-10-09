# Velio invitation guest app

Use Flutter 3.47.6 / Dart 3.13.5. Dependencies and lockfile are pinned. Start the API and dependencies using the [root setup guide](../README.md), then:

```sh
flutter pub get --enforce-lockfile
flutter run -d <device-id> --dart-define=API_BASE_URL=http://127.0.0.1:3000
```

The guest screen accepts grouped or lowercase codes. Before identity setup it shows the inviter's name/role, public-link or recipient-bound vouch trust semantics, meeting place, date/time in the activity's IANA timezone, price and the latest fetched availability. Invitations reserve nothing; capacity is checked again in PostgreSQL when claiming. The shared WebSocket stream updates versioned availability and confirmed participants. New claims wait for fresh HTTP context and a foreground live snapshot.

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

`guest-v1.json` in application-support storage contains the selected identity, code/name/contact draft, journey, actor/code claim keys, unresolved claims, celebrated bookings, undelivered events and per-code saved invitation/activity/participant details and confirmation. Writes are serialized, flushed to a temporary file, then renamed. A claim is sent only after its request key and pending state have been saved. Retry/reopen uses the same key, and own-booking lookup runs before a new claim. Restart restores the selected identity and checks its booking even if the invitation has become full or expired. During same-invitation refresh, in-memory details and an existing confirmation remain visible; stale availability is labelled and fresh claims wait for revalidation. Storage initialization errors are visible and do not silently discard the session.

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

## Vouches, offline details and live recovery

Vouches target one saved demo contact. Creating an identity accepts an optional contact; it is required to match a vouch but remains optional for public invitations. Email case and outer spaces are ignored; phone spaces, dashes, dots and parentheses are removed. No country prefix is inferred: use the same saved phone format. Existing identities are selected only after a server match check, except that an existing booker can always recover their membership. Wrong-recipient and already-used states explain the contact restriction without displaying the intended contact. Contacts are unverified and matching is a demo simulation, with the enumeration limits in [the contract](../docs/contracts/api.md#vouches-issue-6).

Saved details and participant names remain readable after restart without connectivity, with a saved timestamp and explicit stale-capacity label. A saved confirmation is shown for its selected actor; reopening online checks its authoritative membership. New offline claims are never queued. Uncertain online requests keep their keys; another intent stays blocked until the earlier confirmation is recovered or the same key is retried. A first-time offline code retains input and offers retry.

The foreground live stream ignores older/duplicate membership, ACKs only after rendering, and closes in background/disposal. Foreground/resume reloads details and obtains a new snapshot before enabling new claims. A stalled stream reconnects; an offline launch retries HTTP while foreground. Tracking derives mobile rail/generation/assignment from the server, with the persistent guest journey retained through preview, claim and ACK. Local contact drafts are stored on the device and never copied to preview events or the public cache.

```sh
flutter test test/guest_live_recovery_test.dart test/guest_journey_test.dart
flutter test integration_test/live_guest_test.dart -d <ios-simulator-id> --dart-define=API_BASE_URL=http://127.0.0.1:3000
```

The native test uses the real API and WebSocket gateway for both rails, rejects missing vouch contact, loses committed claim responses, checks live membership, backgrounds/resumes, restarts with offline saved confirmation and reconnects without another claim. Its server fixtures are test-marked. [Executed evidence](../docs/verification/flutter-live-recovery.md).
