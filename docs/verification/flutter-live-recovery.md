# Flutter vouch, live and offline recovery (#9)

Executed locally on 9 October 2026 (Africa/Lagos). Scope: PLANS.md §2.5, §3.3–3.5 and §4.1–4.2.

## Native evidence

Flutter 3.47.6 / Dart 3.13.5, booted iPhone 17 simulator on iOS 26.2, API listener `127.0.0.1:3099`, PostgreSQL 17.6 and Redis 8.2.1. The native integration test passed both invitation rails using the real API, shared WebSocket protocol and test-marked server fixtures:

```sh
flutter test integration_test/live_guest_test.dart -d 8860318F-EE81-4AD3-86FB-0D4A368032A2 --dart-define=API_BASE_URL=http://127.0.0.1:3099
```

Each rail rendered details before identity setup, created an invite-acquired identity, submitted one claim, deliberately discarded its committed response and recovered the same booking. The vouch path first rejected a missing contact and preserved the entered name. Both showed the guest among live participants and full availability, stopped live delivery in background, refreshed on resume, reconstructed the session from disk with HTTP/live connectivity disabled, showed saved confirmation and participants with stale labels, and reconnected without another claim. Background/resume transitions were injected through Flutter's binding; this is not evidence of operating-system process eviction. Restart uses a newly opened application-support session file and a recreated screen. Real cold-start link routing was already verified in #8; Android native execution is not part of this run.

| Rail | Journey | Activity | Booking |
|---|---|---|---|
| public | `5846a868-1974-46cf-8de3-5b3b238736a4` | `32bdfe36-1d52-4bdd-9a9f-8a24d9169b0e` | `68a414d9-897c-4f81-a172-7202beb9271d` |
| vouch | `003187f8-ba49-4d37-b2c7-9835be2f86aa` | `21629a31-4445-4715-af0c-568c93002df1` | `34c23277-92f4-494a-ac6c-bbaa79a912de` |

Read-only SQL inspection of these exact journeys found, per rail: three rendered opens and activity views (initial, resumed and reconnected), one identity creation, one booking intent/claim attempt, one `booking_succeeded`, one `spot_claimed`, one committed request outcome and one `availability_applied`. All were mobile and test-marked. Success and applied events retained the same journey, selected actor, authoritative rail, generation 1 and persisted treatment assignment. Event-ID replay returned `accepted: false`. Recovery created no second logical success. Intended contacts were absent from event envelopes/context.

There was one observed live booking delivery per rail, with one ACK each and no missed expected delivery for those connections. Local commit-observed delays were 128.68 ms (public) and 161.42 ms (vouch). Two samples cannot establish a p95 SLO or production attainment. Clients absent/offline during later cached viewing are outside foreground delivery coverage.

The following diagnostic query returned one deduplicated open and one converted journey for each rail. It explicitly restricts the cohort to the two executed fixtures; this synthetic result is not user conversion evidence. Full product-cohort query verification remains required in final assessment verification (#12, following analytics #10).

```sql
WITH opened AS (
  SELECT DISTINCT invite_id, journey_id, context->>'rail' AS rail
  FROM analytics_events
  WHERE name = 'invite_opened'
    AND journey_id IN ('5846a868-1974-46cf-8de3-5b3b238736a4',
                       '003187f8-ba49-4d37-b2c7-9835be2f86aa')
), converted AS (
  SELECT DISTINCT invite_id, journey_id
  FROM analytics_events
  WHERE name = 'spot_claimed'
    AND journey_id IN ('5846a868-1974-46cf-8de3-5b3b238736a4',
                       '003187f8-ba49-4d37-b2c7-9835be2f86aa')
)
SELECT rail, count(*) AS deduplicated_opens,
       count(c.invite_id) AS converted_journeys
FROM opened o LEFT JOIN converted c USING (invite_id, journey_id)
GROUP BY rail;
```

## Automated seams

Flutter screen tests cover vouch selection/rejection and saved input, persistent cached/uncached state, ordered/duplicate snapshots, visible-frame ACKs, background ACK suppression, fresh foreground gating, response uncertainty, request-key persistence and confirmation recovery. Real backend tests cover recipient matching without mutation, missing actor, consumed-vouch reopen, direct-booking recovery, expiry/status ordering, transaction rollback, capacity races and mobile ACK attribution/deduplication. Native tests exercise the combined transport and rendered flow.

The root `npm test` passed 12 tooling, 120 backend and 104 web tests. TypeScript typechecking passed. Flutter analysis passed with no issues; all 41 Flutter tests passed. Backend/web production builds passed.
