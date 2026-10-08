# Group bookings, live availability and trusted invitations

**Author:** Jahtofunmi Osho  
**Assessment:** Velio Senior Fullstack Engineer  
**Planning date:** 8 October 2026  
**Status:** Pre-implementation plan. Decisions below are working assumptions; changes during the build will be recorded in the decision log.

## Product intent

Help a host fill an activity, help a booker bring someone they know, and help an invited guest decide and join confidently from their phone. A booking is useful only if the participant understands the commitment, and an invitation is useful only if the guest can act on it.

The assessment calls the two invitation methods **rails**: a specific-contact vouch and a public share link. In the data and tracking, `rail` records which method was used.

The central journey is: host creates an activity -> booker confirms a seat -> booker creates a contact vouch or public link -> guest previews and claims in the Flutter app -> all connected clients see the same committed availability and plan membership.

I will protect this complete journey across backend, web and mobile. PostgreSQL decides whether a seat exists. Invitations describe trust and attribution; they do not promise unreserved capacity. Tracking will distinguish technical correctness, acquisition and participation, rather than treating link creation as the final outcome.

## 1. Scope questions and working assumptions

### 1. What is a Plan, and what proves it actually happened?

**Concern:** The scope could mean one group per activity or several private friend groups. It also names plans that happen as a core outcome, but the required funnel ends at a booking.

**Assumption:** One activity is one scheduled occurrence with one shared plan. Its confirmed bookings are its participants. The host does not use a seat unless they explicitly book. A plan with at least two confirmed participants is a provisional formed-plan metric, not proof of attendance. The prototype will show confirmed participants; a host-confirmed completion/attendance action is a bounded extension after the required journey works. Without that extension, actual attendance will be labelled unmeasured.

### 2. Does an invitation reserve a seat, and who may redeem a vouch?

**Concern:** A booker could believe inviting a friend guarantees a place. A vouch also loses its meaning if any person holding the code can redeem it as a trusted contact.

**Assumption:** Only a committed booking consumes capacity. One person may book one seat per activity. Vouches identify one intended contact and allow one logical successful redemption; the same recipient can retry or reopen their booking. Public links allow multiple distinct guests while capacity remains. Neither invitation type reserves seats. A demo contact identity will simulate recipient matching; real verification is outside this assessment. Invites expire after 24 hours or at activity start, whichever comes first.

### 3. What counts as an available booking attempt and an open client for the SLOs?

**Concern:** Fifty people may see the same last seat. The 49 who lose that race are not infrastructure failures. Offline or suspended clients cannot meet a two-second live-update promise.

**Assumption:** Availability is authoritative at the serialized booking decision in PostgreSQL. The reliability metric separates committed bookings, sold-out outcomes, invalid requests, replays and technical errors. Errors before capacity can be established remain visible as unknown-eligibility failures. The live-update target applies to connected, subscribed, foreground clients; missing acknowledgements and coverage are reported, and returning clients refresh current state.

### 4. What do generation, conversion and K-factor mean when users open multiple invitations?

**Concern:** Existing users may join through invitations, public links may have many visitors, and the same person may open several codes. Without definitions, both referral history and conversion can be misleading.

**Assumption:** Signup generation describes a user's signup referral history across the product: organic users are generation 0; a new invited user is their inviter's signup generation + 1. The first valid signup attribution is immutable. Existing users keep that signup referral history; a later activity booking gets separate invitation attribution. Invite generation/root are snapshots of that signup referral history, rather than a separate referral chain for each activity. If activity-local hop depth is desired, I would add a separate field. Conversion uses deduplicated guest journeys and fixed observation windows, with rail and availability breakdowns. Host distribution is tracked separately from the booker-inviter target.

### 5. How will we prove invitations cause more useful plans?

**Concern:** Engaged users may naturally invite more. If feature access is assigned to individual users, someone in treatment can invite a friend in control into the same activity. The friend's participation is then influenced by the feature they were meant not to receive. Both groups also compete for the same limited seats, so bookings in one group change the other group's opportunities. A simple user-level comparison would not cleanly isolate the invitation feature's effect.

**Assumption:** The invite feature has a persisted activity/plan-level holdout: ordinary booking remains available in both groups, but new invite creation is disabled in control. Primary outcomes are confirmed participants and qualifying formed plans per assigned activity. This reduces within-plan interference but does not eliminate cross-plan social spillovers. An improvement to invite conversion needs a separate comparison with the existing invite experience, since a no-invite control has no invite-open conversion rate.

## 2. Technical implementation plan

### 2.1 Architecture and stack

| Component | Choice | Reason |
|---|---|---|
| Backend | Node.js, TypeScript, Express, boundary validation | A small API with explicit domain services and predictable errors |
| Database access | node-postgres, parameterized SQL and versioned SQL migrations | Makes the critical transaction and lock behavior easy to inspect |
| Storage | PostgreSQL | Bookings, referral history, durable events and capacity share one transactional authority |
| Live transport | Redis Pub/Sub and WebSockets | One live protocol for the web and mobile apps; Redis can distribute updates between API processes |
| Web | React, TypeScript and Vite | Responsive host/booker experience without unnecessary server-rendering requirements |
| Mobile | Flutter | Focused native guest journey, persistent cache and haptics |
| Infrastructure | Docker Compose for PostgreSQL and Redis | Reproducible local dependencies, migrations and seeds |
| Tracking | Durable PostgreSQL events/queries plus a small tracking view | Reviewers can inspect both operational results and product calculations |

The project will use one monorepo with root-level `backend/`, `web/` and `mobile/` applications, alongside `PLANS.md`, `OWNERSHIP.md`, `README.md` and `docker-compose.yml`. Root commands will coordinate local setup and verification. Node workspace tooling will cover the TypeScript applications; the Flutter app will keep its own Dart dependencies and commands. A monorepo-foundation ticket will establish these boundaries and runnable skeletons before feature tickets begin.

The API will have activities, bookings, invites/attribution, live subscriptions and tracking modules inside one application. The web and mobile apps share the API contract and booking service. Runtime and migration database roles will be separate. Docker versions and package dependencies will be pinned in the implementation and documented; no service credentials will be committed.

### 2.2 Data model and invariants

| Entity | Main responsibility |
|---|---|
| `users` | Stable demo identity; display/contact fields; immutable signup generation, acquisition parent/root and invite reference |
| `activities` | Host, title, description, meeting location, start/timezone, status, capacity, confirmed count, price/currency and availability version |
| `plans` | One shared plan per activity, enforced by a unique activity reference |
| `bookings` | Confirmed user/activity membership and price snapshot; unique user/activity pair |
| `invites` | Immutable code, inviter, activity/plan, rail, intended recipient for vouch, expiry and referral history snapshot |
| `invite_redemptions` | Append-only edge identifying who invited whom, code, rail, generation and confirmed booking |
| `signup_attribution` | Append-only first acquisition record for each user; never rewritten by a later booking |
| `idempotency_keys` | Actor, operation, key, request fingerprint and committed result |
| `analytics_events` | Deduplicated events with schema version, journey/entity references, outcome and experiment context |
| `outbox_events` | Committed domain updates awaiting Redis publication, with retry/dispatch metadata |
| `experiment_assignments` | Persisted experiment version, activity assignment and allocation |

Key invariants:

- Capacity is a positive integer; confirmed count is between zero and capacity.
- Confirmed booking rows and the stored count agree. A reconciliation query checks this independently of the counter constraint.
- One confirmed booking consumes one seat and establishes one participant. Participants are read from bookings rather than a second independently mutable list.
- Activity price is a non-negative integer in minor units with an explicit currency. Booking price is snapshotted.
- Times are stored as absolute timestamps with an IANA timezone for display. The server rejects claims after activity start.
- Vouches require an intended recipient and allow one successful redemption; public invites do not have a single-recipient restriction.
- Signup referral history, invite provenance and successful redemption history cannot be updated/deleted by the runtime database role. Mutable identity display fields and outbox delivery state are separate from that history.

The prototype will not offer arbitrary schedule, price or capacity editing after bookings. If later added, capacity must never drop below confirmed participants, and material changes need a participant communication policy.

### 2.3 API contract

| Operation | Behavior |
|---|---|
| Create/select demo identity | Persist a stable actor; optional valid invite context stamps a newly created identity |
| Create/list/view activities | Host creation, discovery/details and authoritative count/version |
| View own booking / plan participants | Recover confirmation and show committed membership; avoid exposing contacts |
| Book an activity | Idempotent seat claim through the shared domain service |
| Create an invite | Host or confirmed booker only; feature assignment enforced server-side |
| Resolve code/link | Preview activity and permitted inviter context; report valid, full, expired or invalid state |
| Claim through invite | Same seat transaction, with recipient/redemption/attribution validation |
| Subscribe / acknowledge availability | Receive versioned snapshots; ACK after client application |
| View tracking | Technical metrics plus the product queries and their sample counts |

Clients send an idempotency key for booking writes, not an inviter id, rail or generation they can invent. The server derives attribution from the invite. Identity selection is explicitly a demo mechanism rather than production authentication. Existing identity replay and booking recovery take precedence over misleading sold-out/consumed-code errors.

### 2.4 Concurrency and idempotency

I will use a short PostgreSQL transaction with `SELECT ... FOR UPDATE` on the activity row. All statements in the transaction use the same checked-out database connection.

1. Validate request shape and identify actor, operation and request fingerprint.
2. Resolve a completed idempotent request; reuse of a key with a different payload is rejected.
3. Lock the activity and recheck existing user/activity booking.
4. If claiming through an invite, validate the recipient, expiry and redemption within the transaction. Any additional invite lock is taken after the activity lock consistently.
5. Check bookable status, start time and remaining capacity.
6. Insert booking, increment confirmed count/version, and insert redemption/attribution where applicable.
7. Persist the committed success event, idempotent result and availability outbox record.
8. Commit and return the authoritative booking and availability.

Concurrent requests for one activity wait for the lock, then see the committed result of earlier requests. Failure before commit rolls back booking, capacity and invitation consumption together. No Redis operation, external request or notification happens while holding the lock. A bounded lock timeout produces a recoverable technical error, never an invented sold-out result.

An existing booking is returned without changing its original attribution. Database uniqueness backs up the service for duplicate submissions with different keys. Requests using the same key converge on the same logical result; failed uncommitted requests can be retried safely.

**Alternatives:** A guarded atomic update is also valid, but related writes still need a transaction. Serializable isolation and optimistic retries add contention/retry complexity here. A Redis lock introduces a second authority unnecessarily. An in-process mutex does not protect multiple API instances. The chosen row-lock strategy favors understandable correctness for this scope; per-activity contention is an accepted trade-off to measure.

### 2.5 Real-time propagation and recovery

Availability changes are written to the outbox with the booking. A small dispatcher publishes them to a namespaced Redis channel; the API forwards snapshots to subscribed WebSocket clients. Failed publication retries without changing the successful booking response. Retried publications may duplicate events, so payloads carry event id, activity id, version and authoritative counts; clients ignore duplicates and older versions.

Redis Pub/Sub does not replay missed messages. On subscription/reconnection, the gateway registers and buffers updates, reads a PostgreSQL snapshot, then applies buffered newer versions. Clients refresh on foreground/resume. A lightweight periodic reconciliation recovers missed updates on otherwise open connections. The connection status is visible; stale data is never presented as a seat guarantee.

Clients ACK a version after applying it to visible state. For local latency measurement, a single API process correlates commit-observed timing and ACKs using its own clock. Server-to-ACK duration includes the return leg, making it a conservative measurement without subtracting unsynchronized device clocks. If recovery uses an outbox creation timestamp, that result is labelled a pre-commit proxy rather than an exact commit time. Multi-node production measurement requires consistent timing correlation and is a documented follow-up.

For each booking, record the relevant connected foreground subscribers. Report the maximum acknowledgement delay per booking and p95 across bookings, alongside per-client p95 and delivery coverage. Missing ACKs are recorded as delivery misses, not silently dropped from the target assessment.

### 2.6 Attribution and auditability

Referral history (also called **lineage**) records the chain of people who brought a user into the product. If Amara joins organically, invites Tunde, and Tunde invites Zainab, their signup generations are 0, 1 and 2. The root is Amara, and Zainab's immediate inviter is Tunde. This history is distinct from the invitation used for a later activity booking.

Codes are opaque and generated server-side. A vouch's contact is matched against the selected demo identity; public links never imply personal trust. Contact identifiers are not exposed in public preview or copied into analytics unnecessarily.

New users receive signup generation 0 organically or inviter signup generation + 1 through a valid invitation. Signup parent/root and acquisition rail are frozen. Each invite records the inviter's referral history at the time it is created; successful booking redemption records the invite edge without resetting a returning user's signup generation. A new identity created through an invite that subsequently fails to book is a signup, not an activated guest.

Attribution records are insert-only for the runtime role, with database guards preventing edits/deletion of immutable records/columns. Migration credentials are not API credentials. A correction appends a new explanatory record rather than overwriting history. This protects against application mutation, not an administrator replacing the database.

### 2.7 Feature flag and rollout

Use a global creation kill switch plus persisted activity-level assignment for `group_invites_v1`. Web and API use the same assignment; hosts cannot bypass it by creating invitations through another endpoint. Seeded demo activities cover treatment and control. This is a small local mechanism, not an external experimentation platform.

Production rollout: internal checks -> limited eligible activities -> expanded treatment with a retained holdout, subject to booking correctness, error rate and delivery health. Allocation is fixed by experiment version; changing rollout does not reassign existing activities. Disabling new invite creation will honor already-issued valid invitations, unless a specific safety incident requires revocation. The holdout design and decision outcomes are defined in the tracking plan.

### 2.8 Risks and mitigations

| Risk | Mitigation |
|---|---|
| Capacity contention | Short transactions, bounded timeouts, no external work under lock, contention metrics |
| Commit succeeds but response is lost | Stable idempotency key and own-booking lookup; confirmation recovery before rebooking |
| Redis/API interruption | Durable outbox, retries, versioning, reconnect snapshot and reconciliation |
| Demo identity is mistaken for verified trust | Explicit demo recipient matching and documented production verification boundary |
| Double-counted acquisition/funnel data | Immutable first signup attribution, event ids, persistent guest journey and cohort definitions |
| Flutter/toolchain or emulator networking delays | Validate a Flutter-to-API roundtrip immediately after the plan; document simulator/device base URLs |
| Scope expands at expense of the core journey | Keep optional work behind completion of required flow, tests and tracking |

### 2.9 Verification

Run real API/PostgreSQL integration tests, not mocked booking tests:

- Start 50 requests from distinct users against one remaining seat; expect one committed booking and 49 graceful sold-out responses.
- Repeat with three seats; expect exactly three successes and consistent booking/count/participant rows.
- Race direct booking and invite claims against the same capacity.
- Submit duplicates with the same and different keys; verify one seat, one booking and immutable attribution.
- Verify recipient-bound vouch behavior, reusable public links, expiry, self-invite rejection and existing-booking recovery.
- Inject a failure before commit and verify full rollback.
- Attempt attribution edits with runtime credentials and verify rejection.
- Interrupt live delivery and demonstrate snapshot/version recovery without corrupting bookings.

Use a connection pool allowing overlapping transactions and coordinated starts; inspect stored records after each race. Run a separate available-capacity workload for success rate and latency, with load, samples, observers and exclusions stated. Local evidence is not a claim of production-month SLO attainment.

## 3. Product implementation plan

### 3.1 Host journey

1. Select a stable demo identity and switch to the host view.
2. Create an activity: title, description, meeting place, date/time, capacity and price/currency. Preview the local time and validate inputs.
3. See the activity's confirmed participants and remaining seats live. Invitations are not counted as attendance.
4. Choose a specific-contact vouch or public share, with clear trust semantics and no reserved-seat promise.
5. See a useful full state when capacity reaches zero. Avoid encouraging guests to claim unavailable places.

### 3.2 Booker journey

1. Browse activities and view full context, price and live availability.
2. Claim one seat; immediately show pending feedback and prevent accidental repeated taps.
3. Show confirmation only after commit, including the activity and plan membership.
4. Offer the two invitation rails when available under the feature flag. Show remaining seats before sharing.
5. If the last seat disappears, explain it kindly and preserve context. If the response is uncertain, check confirmation rather than assert failure.

Host activity creation will optimistically show a pending list entry with rollback on rejection. Confirmed seat count and booking success remain server-authoritative. This provides reversible optimistic behavior without promising a scarce seat prematurely.

### 3.3 Invited guest journey in the Flutter app

1. Open a documented app link or enter a code. Code entry remains a dependable fallback.
2. View activity, inviter context, date/time/timezone, price and availability before identity setup.
3. Select/create a simple stable identity when ready to claim. For a vouch, explain intended-contact matching without publicly revealing that contact.
4. Claim through the shared booking service with an idempotency key.
5. Show plan confirmation, with subtle success haptics after the confirmed outcome.
6. Restore confirmation on a repeat visit; refresh state on resume/reconnection.

Cache activity details and invitation context persistently. Cached details carry a saved/offline label; capacity is stale offline. New claims require connectivity. An unresolved online claim retains its key and is checked after reconnection. First-time offline visitors get a helpful retry state rather than a nonexistent cache. Preserve the code and entered data through loading, errors and navigation.

A responsive web invite preview will give link recipients context and a code/app-opening path. Automatic code recovery after a fresh installation is not assumed; full deferred deep linking and App Clips are follow-up work.

### 3.4 Edge states

| Situation | User behavior |
|---|---|
| Activity sells out while claiming | “The last spot was just taken.” Retain details and allow return to activities/another code |
| Invite points to a full activity | Show the invitation context with sold-out state before identity/claim |
| Expired or invalid code | Distinguish states; preserve input and allow another code |
| Redeemed vouch reopened by its recipient | Restore the existing booking |
| Wrong recipient / vouch used by someone else | Explain recipient-bound eligibility; do not consume capacity |
| Public link opened by several guests | Accept distinct eligible claims while places remain |
| Already booked without this invite | Show existing booking; do not add a second seat or change referral history |
| Activity started/cancelled | Show status and block new claims |
| Timeout or disconnection after submission | “Checking your confirmation”; lookup/retry with the same key |
| Offline with saved details | Read-only saved context, stale availability and reconnect action |
| Reconnection/background return | Revalidate before enabling claim; retain booking/code context |

Use consistent loading, empty and error states, accessible labels, usable touch targets and readable contrast on web and mobile. Client validation helps the user; server validation remains authoritative.

### 3.5 Prototype commitment and next release

**Committed assessment scope:** all three applications; host creation/management of activity listings and live participants; booker details/booking/invitation; mobile guest code/link preview/claim/cache/haptics in the Flutter app; both invitation rails; immutable signup and booking attribution; concurrency/idempotency tests; Redis-backed live updates with outbox/recovery; queryable technical/product tracking; basic feature assignment; the requested documentation.

The host-management scope covers creating and inspecting activities and their bookings. Arbitrary editing/cancellation is deferred rather than silently introducing schedule/price changes after people commit.

**After the required scope passes:** add a small host-completion/attendance action if feasible. If not built, keep actual plans-happened measurement explicitly outstanding. Visual polish follows working error/recovery states, not the other way around.

**Next release:** safe cancellation/capacity release, an opt-in waitlist with offers or consented promotion, verified identity/contact vouches, reminders, participant communication for changed activities, recurring occurrences and production monitoring. Friend-seat holds require a separate fairness/expiry decision; payments, trust scores and host verification remain outside this assessment. AI, maps and chat are not prerequisites for proving this feature.

## 4. Tracking implementation plan

### 4.1 Events and integrity

Server events establish committed business truth; clients report rendered previews and applied availability. Each event has an id, schema version, timestamp, source, relevant actor or anonymous journey, activity/plan/booking/invite references, platform, rail/generation where valid, and experiment assignment.

| Event | Source and meaning |
|---|---|
| `activity_viewed` | Client rendered activity details |
| `booking_attempted` | Server received a valid booking intent; includes request/idempotency correlation |
| `booking_succeeded` | Transaction committed a new booking; replays do not create another success |
| `booking_sold_out` | Authoritative capacity rejection, distinct from a technical failure |
| `booking_failed` | Technical/domain failure with stage, reason and capacity eligibility/unknown flag |
| `invite_created` | Server committed an invite; invitation type (`rail`), creator context and referral history attached |
| `invite_opened` | Human guest journey rendered invitation state, including full/expired states; not a link-preview GET |
| `identity_created` | Server created identity and immutable acquisition ancestry |
| `invite_claim_attempted` | Guest submitted an invitation-backed seat claim |
| `spot_claimed` | Invitation-backed booking committed; linked to the guest journey |
| `availability_applied` | Client applied a version, acknowledged to the server |
| `experiment_exposed` | Assigned experience shown; assignment remains available independently of exposure |

Booking success, claim and invite-creation events persist with the domain transaction. Attempt/failure telemetry lives outside a rolled-back business transaction so rejections do not disappear. A telemetry outage is visible and does not convert an already committed booking into failure. Persistent client journey ids connect anonymous opens to later identity/claim; event-id uniqueness prevents duplicate ingestion. Client-supplied rail/generation is not trusted.

### 4.2 Metric definitions, targets and improvement triggers

The following windows/sample thresholds are initial operational assumptions for this exercise, not claims about Velio's established policy. Counts and observation windows are always shown. Production thresholds should be reviewed against actual volume and statistical uncertainty.

| Goal | Metric and measurement | Target | Trigger for an improvement plan |
|---|---|---|---|
| Never oversell | Count activities where confirmed booking rows exceed capacity; separately detect counter mismatch | Zero | Any violation: incident, pause new booking writes/rollout as appropriate, investigate and repair with audit |
| Available booking success | `S / (S + F)`, where S is successful distinct booking intents and F is eligible technical failures; also show conservative `S / (S + F + U)` including unknown-eligibility failures U | >=99.5% | Rate below target with >=1,000 resolved intents, or repeated technical failures/error-budget burn before that sample |
| Live availability | p95 of per-booking maximum commit-observed-to-ACK delay among relevant foreground subscribers; show per-client latency, coverage and delivery misses | <=2 seconds | Breach over >=50 observed booking updates, or any recurring missed-delivery pattern; missing ACKs count as misses |
| Bookers invite | Distinct qualifying bookers creating an invite within 24h / distinct qualifying bookers with a mature 24h window | >=30% | Below target with >=200 mature booker journeys; inspect confidence/segments before a rollout decision |
| Opens convert | Unique (invite, guest journey) opens that yield attributed claims within 24h or activity start / unique opened journeys with mature windows | >=25% | Below target with >=200 mature journeys; diagnose mobile, rail, availability and funnel stage |
| K-factor by rail | Distinct new signups directly acquired by each rail / same defined eligible existing-user cohort | No numerical target supplied | Sustained weak acquisition/activation or no useful experimental lift prompts review; do not invent a K>1 requirement |
| Plans that happen | Formed plans are measured separately from host-confirmed completion/attendance | No numerical target supplied | No positive incremental formed-plan outcome after the planned experiment, or worse attendance/cancellation guardrails |

Reliability excludes invalid domain requests, sold-out decisions and idempotent replay requests from new logical intents. Failures before capacity can be checked are not silently removed: show unknowns and conservatively include them in a companion rate. Also report raw request outcome counts and per-request retry/error rate so eventual success does not hide a poor experience.

The live target is assessed with both latency and coverage. If any relevant update is missing, the summary cannot claim the every-client objective was met merely because the successful ACK samples were fast. Unobserved/offline clients are identified, not presumed updated. Production analysis should include timeout/miss rates, not just a successful-sample quantile.

For the booker metric, use each user's first successful booking within the reporting cohort as the qualifying journey and count an invite for that activity within 24h. Hosts who have not booked are a separate creator segment. Report the cohort definition so the number is reproducible rather than quietly mixing user and booking denominators.

For conversion, keep the raw headline measure including human opens to full/expired invitations. Add eligible-open conversion and reason breakdowns for diagnosis. Repeated opens of the same invite/journey are deduplicated. Existing bookers who reopen their confirmation are recovery traffic rather than new guest acquisition. Cross-device visitors without a resolved identity remain a stated measurement limitation.

For K, choose an existing eligible host/booker cohort at the start of a seven-day observation window, including people who never create an invitation. Count distinct new users directly attributed to those inviters, separately by frozen acquisition rail; use the same denominator for both rails. Deeper descendants are shown by generation separately. Activated K requires the new user to claim within the window. Returning guests are participation, not new-user K. Invitations created by users acquired during the window belong to their subsequent cohort rather than inflate the original direct K.

### 4.3 What reviewers can inspect

- A `/metrics` endpoint or tracking page with attempts, successes, replay/invalid/sold-out/error counts, SLO summaries, latency/coverage, and sample counts.
- Runnable SQL views/queries for booker-to-inviter share, open-to-claim conversion and K by rail, with the operational definitions above.
- Rail, platform, signup generation, availability-at-open and new/returning breakdowns.
- Labelled seed scenarios that verify calculations, including empty denominators, repeated opens, host invitations and returning users.
- A separate local test report stating environment, request overlap, sample sizes and measured results. No invented pass claims before execution.

An empty cohort returns no data, not a fabricated 0% or pass. Synthetic/test identities and events are marked so load tests do not contaminate demo product metrics. Real attainment of the 30%/25% targets remains unvalidated without actual users. Price display without payment and demo identity also limit comparison with production commitment.

### 4.4 Holdout design

Before exposure, persist a deterministic, versioned activity-level assignment to invite-enabled treatment or ordinary-booking holdout. After a small safety rollout, a proposed 90/10 split retains a stable control; sample needs must be checked before choosing that allocation. Both groups have the same booking correctness, activity details and prices. Only treatment supports the new vouch/public creation experience, with host and booker eligibility enforced by the API. Compare all assigned activities on confirmed participants and plans reaching the provisional two-person threshold in a fixed window, rather than conditioning on invitation usage. Measure signup/activated acquisition separately and collect attendance once available. Track booking reliability, live delivery and later cancellation/no-show guardrails. Persist assignment even when exposure fails, assess uncertainty at a predeclared review point, and account for activity-level clustering. Users crossing activities and friend spillovers remain limitations; a production study may need community/network clustering. A follow-up guest-UX experiment compares improved and original invitation flows with invites enabled in both groups, separately from this no-invite holdout.

## 5. Build sequence and handoff

1. Commit this plan before implementation. Confirm Docker, Node and Flutter/emulator availability; run a Flutter-to-API request early.
2. Complete the monorepo-foundation ticket: establish the root workspace/configuration, backend, web and mobile skeletons, Compose health checks, environment examples and root setup/verification commands. Verify web and the Flutter app can reach the API. Document the initial request/error and event contracts before parallel feature work; add domain migrations, runtime grants and labelled seeds with the feature tickets that own them.
3. Implement shared booking, idempotency and invitation attribution. Run the capacity/rollback tests before UI expansion.
4. Add outbox/Redis/WebSocket propagation, versioned recovery and event tracking. Establish the three product queries.
5. Finish the responsive host/booker web flow and mobile guest flow with cache, haptics, links/codes and recovery states.
6. Run the complete journey and local concurrency/latency checks. Fix observed failures before optional completion/attendance or extra polish.
7. Complete `README.md` and one-page `OWNERSHIP.md`; record deviations here and prepare the repository handoff.

The README will cover running every component, migrations/seeds, simulator/device URLs, test commands, architecture/concurrency, tracking access, shortcuts and production follow-up. The ownership document will address the provided 11% conversion scenario with ranked hypotheses, measurable improvements, an appropriate control and a reasoned decision.

### Review demonstration

Create a two-seat activity on web -> book one seat -> create a vouch -> preview/claim in the Flutter app -> observe live sold-out state and participants -> recover the same booking after a retry -> show a graceful losing claim -> repeat public sharing and verify the recorded inviter, invitation type, code and generation -> demonstrate cached offline details/reconnection -> run the concurrency test -> inspect metrics and product queries.

## 6. Decision log: plan versus implementation

Implementation entries retain the original planned decision and explain changes rather than rewriting the plan to imply they were always intended.

| Date | Planned decision | What changed | Reason and user/measurement impact |
|---|---|---|---|
| 8 October 2026 | Booking schema/writes arrive with the shared-booking ticket after host activity creation. | #2 establishes the minimal confirmed-booking table and read-only runtime access for participant inspection; #3 owns booking writes, attribution, idempotency, counter updates and outbox. | Participant inspection reads its real future source immediately, avoiding a second mutable list or a placeholder participant model. Hosting creates no membership. |
| 8 October 2026 | Enter a date/time with an absolute stored start and IANA display timezone. | The web labels date entry as device-local time and previews that same instant in the selected display zone and UTC. | Keeps the conversion explicit without introducing a timezone conversion dependency; non-existent local times are rejected. Booking eligibility checks remain #3. |

## Reference checks

- [Assessment brief](https://app.notion.com/p/velioapp/Velio-Engineering-Assessment-3f26935bd88981dbaaceea8a2f28eb7b): requirements are based on the supplied document, not unverified assumptions about Velio's codebase.
- [PostgreSQL row locking](https://www.postgresql.org/docs/17/explicit-locking.html) and [node-postgres transactions](https://node-postgres.com/features/transactions): transaction/locking behavior and using one connection.
- [Redis Pub/Sub delivery](https://redis.io/docs/latest/develop/pubsub/): missed subscriber messages require a recovery strategy.
- [Flutter offline architecture](https://docs.flutter.dev/app-architecture/design-patterns/offline-first): cached reads and operation-specific write behavior.
