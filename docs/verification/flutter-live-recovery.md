# Flutter vouch, live and offline recovery (#9)

Executed locally on 9 October 2026 (Africa/Lagos). Scope: PLANS.md §2.5, §3.3–3.5 and §4.1–4.2.

## Native evidence

Flutter 3.47.6 / Dart 3.13.5, booted iPhone 17 simulator on iOS 26.2, API listener `127.0.0.1:3099`, PostgreSQL 17.6 and Redis 8.2.1. The native integration test passed both invitation rails using the real API, shared WebSocket protocol and test-marked server fixtures:

```sh
flutter test integration_test/live_guest_test.dart -d 8860318F-EE81-4AD3-86FB-0D4A368032A2 --dart-define=API_BASE_URL=http://127.0.0.1:3099
```

Each rail rendered details before identity setup, created an invite-acquired identity, submitted one claim, deliberately discarded its committed response and recovered the same booking. The vouch path first rejected a missing contact and preserved the entered name. Both switched existing demo identities before claiming (including rejection of a nonmatching vouch candidate), showed the guest among live participants, stopped live delivery in background while the host booked the second seat, and refreshed on resume to full availability and both participants. They reconstructed the session from disk with HTTP/live connectivity disabled, showed saved confirmation and participants with stale labels, and reconnected without another claim. Background/resume transitions were injected through Flutter's binding; this is not evidence of operating-system process eviction. Restart uses a newly opened application-support session file and a recreated screen. Real cold-start link routing was already verified in #8; Android native execution is not part of this run.

| Rail | Journey | Activity | Booking |
|---|---|---|---|
| public | `234d7da4-6489-4b23-931b-711c36f8b12f` | `1f6b5181-8236-4eff-9dd2-2ecea8344031` | `e00edff3-f07b-4b26-a280-4c54ee8405d8` |
| vouch | `f98d22da-1232-44f2-9c35-363f7911c065` | `63ac10c3-dc06-4c11-8aae-46390c8e68af` | `91fbcb23-29ff-4c61-8910-107ce48d65c4` |

Read-only SQL inspection of these exact journeys found, per rail: four rendered opens and activity views (initial, resumed, saved offline and reconnected), one identity creation, one booking intent/claim attempt, one `booking_succeeded`, one `spot_claimed`, one committed request outcome and one `availability_applied`. All were mobile and test-marked. Success and applied events retained the same journey, selected actor, authoritative rail, generation 1 and persisted treatment assignment. Event-ID replay returned `accepted: false`. Recovery created no second logical success. Intended contacts were absent from event envelopes/context.

There was one observed live booking delivery per rail, with one ACK each and no missed expected delivery for those connections. Local commit-observed delays were 156.42 ms (public) and 82.04 ms (vouch). Two samples cannot establish a p95 SLO or production attainment. Clients absent/offline during later cached viewing are outside foreground delivery coverage.

The following diagnostic query returned one deduplicated open and one converted journey for each rail. It explicitly restricts the cohort to the two executed fixtures; this synthetic result is not user conversion evidence. Full product-cohort query verification remains required in final assessment verification (#12, following analytics #10).

```sql
WITH opened AS (
  SELECT DISTINCT invite_id, journey_id, context->>'rail' AS rail
  FROM analytics_events
  WHERE name = 'invite_opened'
    AND journey_id IN ('234d7da4-6489-4b23-931b-711c36f8b12f',
                       'f98d22da-1232-44f2-9c35-363f7911c065')
), converted AS (
  SELECT DISTINCT invite_id, journey_id
  FROM analytics_events
  WHERE name = 'spot_claimed'
    AND journey_id IN ('234d7da4-6489-4b23-931b-711c36f8b12f',
                       'f98d22da-1232-44f2-9c35-363f7911c065')
)
SELECT rail, count(*) AS deduplicated_opens,
       count(c.invite_id) AS converted_journeys
FROM opened o LEFT JOIN converted c USING (invite_id, journey_id)
GROUP BY rail;
```

## Automated seams

Flutter screen tests cover vouch selection/rejection and saved input, persistent cached/uncached state, ordered/duplicate snapshots, visible-frame ACKs, background ACK suppression, fresh foreground gating, response uncertainty, request-key persistence and confirmation recovery. Real backend tests cover recipient matching without mutation, missing actor, consumed-vouch reopen, direct-booking recovery, expiry/status ordering, transaction rollback, capacity races and mobile ACK attribution/deduplication. Native tests exercise the combined transport and rendered flow.

The root `npm test` passed 12 tooling, 120 backend and 104 web tests. TypeScript typechecking passed. Flutter analysis passed with no issues; all 48 Flutter tests passed. Backend/web production builds passed.

## Initial review

The two-axis review used starting commit `0d29abcb` as its baseline. Standards review found no documented breaches; its two readability suggestions were resolved by encapsulating pending-claim keys and sharing the visible-frame ACK guard. Spec review found and resolved an identity-switch recovery bug: recovering an earlier uncertain claim on the same invitation could retain another actor's confirmation. A regression test now verifies the selected actor's authoritative lookup clears that confirmation while preserving the original request key.

Final review: zero outstanding Standards findings and zero outstanding Spec findings. Cached previews now record their actual foreground render and retain those events for delivery after reconnection.

## PR #23 review corrections

The code-review-v3 review identified two major state bugs and four minor issues. Permanent regressions reproduced the stale participant list, candidate confirmation before failed identity persistence, rejected-candidate recovery mutation, local recovery-write error, device clock ahead/behind, and repeated unchanged snapshot writes before their fixes.

Participant cache version is now independent of HTTP preview version; the version-2 cache → HTTP version 3 → WebSocket version 3 regression verifies displayed and persisted membership, and older snapshots cannot replace it. Candidate checks stay local until the actor is saved; failures/rejections retain the original actor, confirmation/recovery flags and live context. A late-response regression verifies a superseded view cannot select its candidate. Local recovery-save failure preserves the pending intent/key and accurately retains the current server-confirmed booking.

Invite-aware snapshots obtain `activity.inviteState` from the same database statement as membership/counts. Clock-skew screen tests keep valid server state enabled on an ahead device and expired server state disabled on a behind device. Real WebSocket tests verify eligibility and same-version cancellation updates alongside ACK attribution. Repeated identical snapshots leave the session bytes and modification time unchanged; meaningful identity, claim-key and pending-state writes remain atomic and immediate. Native and injected handshakes use one timeout constant.

The expanded native run passed public and vouch identity switching, committed-response loss/recovery, version-3 membership after background/resume, persisted two-person membership during offline restart, and reconnect with the same booking and no second claim. All 48 Flutter tests, analysis, 120 backend tests, TypeScript typechecks and backend/web builds passed after these corrections. The synthetic fixtures and Android/process-eviction limitations above still apply.

Final code-review-v3 re-review of the corrections against `b08b794`: all eight static criteria and simulation completed, with zero remaining findings. React/Next.js criteria were inapplicable to this Flutter/backend changeset.
