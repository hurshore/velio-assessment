# Flutter public-invite preview and committed claim (#8)

Verified on 9 October 2026 (Africa/Lagos), using Flutter 3.47.6 / Dart 3.13.5, the booted iPhone 17 simulator running iOS 26.2, and the local Express API with PostgreSQL 17.6 and Redis 8.2.1. Scope follows PLANS.md §2.3, §3.3–3.4, §4.1 and §5; vouches, subscriptions and the full offline cache/recovery slice remain #9.

## Executed simulator journey

`node scripts/check-mobile-guest.mjs 8860318F-EE81-4AD3-86FB-0D4A368032A2` passed the real Flutter integration test. The helper opened the registered `velio://invite/<code>?journey=<UUID>` route. iOS showed an app-opening prompt, which was accepted. The app adopted the linked journey, rendered invitation details before identity setup, created an invited demo identity, and claimed the last seat. A transport fixture deliberately consumed and discarded the successful claim response; own-booking lookup restored its committed confirmation. Reopening from a persisted session restored the identical booking. On a second activity, code entry rendered the last open seat for an existing guest. A real direct booking took that seat immediately before the guest screen's claim reached the API. The simulator rendered `SOLD_OUT` with the meeting place and entered code retained, then refreshed to the full preview. Replaying the original rendered event returned `accepted: false`.

The fixture host is explicitly `test: true`; its activity, invite and invited identity inherit markers. This is local functional evidence, not production conversion or SLO attainment.

[Recorded event/booking evidence](flutter-public-invites.json) shows:

- One persistent journey across anonymous `invite_opened`/`activity_viewed`, server `identity_created`, `invite_claim_attempted` and `spot_claimed`.
- `platform: mobile` throughout. Invite events carry server-derived public rail and the persisted treatment assignment.
- Reopening emits an actor-bound `invite_opened` with `recovery: true`; the anonymous initial open has `recovery: false`.
- Exactly one `booking_succeeded`, one `spot_claimed`, one booking and one public redemption; capacity and confirmed count are both one.

## Automated behavioral checks

The confirmed test seams are the rendered guest journey and the persisted session/API boundary. Focused tests cover anonymous rendered events, preview-before-identity, invited signup payload, committed confirmation, replay without another haptic, full/expired/started/cancelled states, malformed previews, last-seat rejection, retained details/confirmation on refresh failure, native URI handling and linked journey adoption. File-backed tests reopen sessions to check stable actor/code keys and exact event-ID/envelope retries. An unresolved claim survives restart and resends the original key. Haptic method-channel assertions require committed success and suppress rejection/reopening vibrations.

A raw TCP peer verifies that three consecutive request timeouts and disposal close stalled response sockets while leaving an injected HTTP client usable. Existing readiness tests still cover loading, errors, retry serialization, malformed envelopes and stale responses after timeout. Readiness now uses the same supported abortable HTTP request mechanism.

`npm run verify` passed after the review corrections: TypeScript checks, 12 root script tests, 106 backend tests, 95 web tests, backend/web builds, Flutter analysis and 26 Flutter tests. All 239 automated tests passed with no skips or failures. The separate final iPhone simulator integration test also passed, including the rendered losing claim and exact event-ID replay (`accepted: false`). [Two-axis review and resolved findings](flutter-public-invites-review.md).

## Limits

The simulator cannot prove a physical vibration is felt; widget tests verify the success-only platform call, and the simulator journey uses the real haptic API. Physical devices and Android native links were not executed. Cold-start buffering is implemented before asynchronous session restoration; the executed OS link check opens an already-running installed app. There is no deferred install linking. First-time offline preview, a persistent details cache and real-time subscriptions remain #9. This slice refreshes fetched details and own-booking state when returning to the foreground. Demo signup has no idempotency endpoint; uncertain signup responses explicitly direct the user to select the existing identity before creating again.
