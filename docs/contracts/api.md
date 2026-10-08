# Shared API contract, version 1

Foundation for PLANS.md §2.3–2.6 and §4.1. The health routes below exist now; domain routes, persistence, and events are owned by subsequent tickets. Changes to planned decisions must be recorded in PLANS.md §6.

## HTTP boundary

JSON under `/api`. Successful responses: `{ "data": <payload>, "requestId": "<server UUID>" }`. Errors: `{ "error": { "code": "NOT_FOUND", "message": "...", "retryable": false }, "requestId": "<server UUID>" }`. The server emits the same UUID in `X-Request-Id`; clients display safe messages and keep this reference for diagnosis. No stack traces or dependency credentials are returned. Dates are UTC ISO-8601 strings; activity display includes its IANA timezone. Monetary amounts are integer minor units plus currency.

- `GET /api/health`: 200, data `{ "status": "ok", "service": "velio-api" }`; process liveness only.
- `GET /api/ready`: checks PostgreSQL `SELECT 1` and Redis `PING` on each request; 200 data `{ "status": "ok", "dependencies": { "postgres": "ok", "redis": "ok" } }`. A dependency failure returns 503 with code `DEPENDENCIES_UNAVAILABLE`, retryable true. Readiness probes are bounded; liveness stays available during outages.
- Unknown paths: 404 `NOT_FOUND`. Invalid JSON: 400 `INVALID_JSON`. Oversized JSON: 413 `PAYLOAD_TOO_LARGE`. Unexpected errors: 500 `INTERNAL_ERROR`, retryable true.

Initial domain error vocabulary: `INVALID_REQUEST` (400), `IDENTITY_REQUIRED` (401), `RECIPIENT_MISMATCH`/`INVITE_NOT_ALLOWED` (403), `NOT_FOUND`/`INVALID_INVITE` (404), `SOLD_OUT`/`ALREADY_REDEEMED`/`IDEMPOTENCY_CONFLICT` (409), `INVITE_EXPIRED`/`ACTIVITY_STARTED` (410), and `TEMPORARILY_UNAVAILABLE` (503). Clients must inspect codes rather than parse messages. Domain tickets finalize endpoint payloads against the canonical plan; these names do not claim those routes exist.

## Booking writes and identity

Demo identity is explicitly selected and persisted; it is not production authentication. Future writes carry the selected actor and `Idempotency-Key` (opaque UUID retained across uncertain outcomes). The server scopes keys by actor/operation and fingerprints payloads. Same key/same intent returns the committed result; changed payload returns `IDEMPOTENCY_CONFLICT`. A retry or own-booking lookup recovers confirmation before showing failure. Different keys still consume only one seat per user/activity. A transaction rollback leaves the intent retryable. Booking responses contain the committed booking, plan membership, price snapshot, and authoritative availability.

## Invitations and acquisition

`rail` is exactly `vouch` or `public`. Vouches are bound to one intended demo contact; public links allow distinct guests while capacity exists. Neither reserves seats. Codes are opaque server-issued values. Requests supply a code, never fabricated inviter, rail, root, or generation. Public previews exclude contacts. Expiry is the earlier of 24 hours after creation and activity start. Existing-booking recovery preserves its original attribution.

Signup generation is immutable product acquisition history: organic 0, new invite signup = inviter generation + 1, frozen parent/root and acquisition rail. Returning users retain signup history; later booking attribution is separate. Invites snapshot the inviter's signup ancestry.

## Events and guest journeys

Schema version `1`. Event envelope: `id` (UUID), `schemaVersion`, `name`, `occurredAt` (UTC), `source` (`server`/`client`), `platform` (`web`/`mobile`), optional `actorId`/persistent anonymous `journeyId`, relevant entity IDs, authoritative `rail`/`generation`, experiment version/assignment, outcome/reason, and synthetic marker. Optional fields are omitted when unknown, never invented. IDs deduplicate ingestion.

Persist a random guest journey ID before rendering an invite; retain it across opens, identity creation, and uncertain claims. `invite_opened` means a human rendered the preview, including full/expired states; link-preview GETs are not opens. Server success events persist atomically with their domain changes; attempt/failure telemetry survives rollback. No contact data in analytics. Event names and metric windows follow PLANS.md §4.1–4.2.

## Versioned availability

Snapshot: `{ "eventId": "<UUID>", "activityId": "...", "version": 1, "capacity": 2, "confirmedCount": 1, "remainingSeats": 1 }`. Versions increase with committed changes; counts come from PostgreSQL. Redis publication uses the durable outbox. Clients ignore duplicate/older versions, subscribe with snapshot recovery, reconcile periodically, and refresh on foreground/reconnect. ACK `{ "activityId": "...", "version": 1, "eventId": "..." }` only after visible application. Cached/offline capacity is labelled stale and cannot enable a claim. WebSocket endpoint/message names and event storage arrive with the live/tracking tickets.
