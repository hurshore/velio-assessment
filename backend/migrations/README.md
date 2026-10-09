# SQL migrations

`npm run migrate` connects using `MIGRATION_DATABASE_URL`, uses an immediate PostgreSQL advisory try-lock (an occupied lock reports “Another migration run is active”), and applies sorted `NNN_description.sql` files in individual transactions. SQL filenames must have exactly three digits (`001_description.sql`), and duplicate number prefixes are rejected before database work. Driver/statement deadlines are 3 seconds; long migrations must deliberately adjust that local runner budget. Applied filenames are recorded in `schema_migrations`; never edit an applied migration. Run from the backend workspace via the root command.

The runner maintains its migration ledger and applies the host domain migrations: organic identities and acquisition history, activity/view events, activities, unique shared plans, and confirmed membership reads. These migrations include explicit runtime grants and immutable-history guards; labelled development seeds run separately. The bootstrap runtime role starts with connection access and no schema creation or domain table permissions; migrations grant only the operations this slice needs.

Migration failures retain the original error and log the filename. Rollback/connection-close failures are reported separately and never replace the original failure.

Host migrations require `RUNTIME_DB_USER` naming the existing runtime login. The runner sets `velio.runtime_role` for SQL grants after obtaining its migration lock. `001` owns organic identity/acquisition/event storage; `002` owns activities, a database-created unique plan and read-only confirmed membership. `npm run seed` adds repeatable synthetic host scenarios using migration credentials; it is separate from schema migration and never resets existing data.

`003` adds actor/operation-scoped booking keys, a durable availability outbox and independent `booking_reconciliation` view; grants runtime INSERT on bookings and UPDATE only on activity count/version, key results and outbox delivery state. Bookings remain immutable to the runtime role. Redis dispatch is owned by #7.

`004` adds `bookings(activity_id) INCLUDE (id)` to keep activity-scoped reconciliation and participant reads from scanning unrelated membership. The reconciliation view, row-lock ordering and capacity constraints are unchanged. A representative 100,000-booking plan comparison is captured in [the booking verification report](../../docs/verification/seat-booking.md).

`005` persists `group_invites_v1` assignment history. It backfills existing activities
using version 1 at 50% without emitting exposure. Runtime may insert/read but cannot
rewrite/delete assignments. New API activity and assignment writes share one SQL
statement. It grants runtime `INSERT (id) ON activities` for server-generated activity UUIDs. Seed files assign only their owned fixtures and preserve existing rows.


`006` is the corrective assignment-integrity migration for already-applied `005`.
It validates a deferred reverse foreign key from activity to assignment and an
independent hash/bucket check. A missing legacy assignment aborts migration visibly;
repair with an explicit cohort before retrying. No trigger invents configuration.
`assign_invite_experiment(activity, version, allocation)` is a security-invoker SQL
helper shared by API creation and seeds, with explicit arguments and no history
rewrite on replay. Runtime assignment update/delete restrictions remain unchanged.

`007` adds expiring outbox dispatch leases/retry scheduling, a booking-transaction origin process marker, durable gateway lifetimes, and live observation/delivery records. Runtime can insert observation denominators and delivery expectations, and update only gateway stop timestamps, issued snapshot versions and ACK timestamps/delays. Booking-owned payloads and immutable booking/referral history remain protected.

`008` indexes persisted outbox creation/origin ranges and exact observation times used by bounded reconciliation pages and windowed metrics. It changes no historical observation/delivery evidence.

`009` owns public invitation and attribution history. `invites` stores the opaque code,
activity/plan, inviter role, rail, expiry and a snapshot of the inviter's signup
ancestry. Composite foreign keys tie invited users and `signup_attribution` to that exact
snapshot (parent, root, rail, generation + 1) and tie each `invite_redemptions` edge to
its invite, booking membership and the invitee's generation, so forged ancestry fails
in the database. Runtime may insert/read invites and redemptions; append-only triggers
additionally refuse ordinary UPDATE/DELETE of invites, redemptions, signup attribution,
corrections and users' ancestry columns from any role. Fixes append to
`attribution_corrections` with migration credentials. `invites_rail_supported` allows only
`public` until the vouch ticket adds recipient binding. `seeds/invites.sql` adds a labelled
attribution chain whose bookings set counts directly, without outbox rows.

`010` adds the vouch rail. Users gain an optional demo `contact` (lowercase email or digits-only
phone, unique when present, set at signup only), and invites gain `recipient_contact`, required
exactly for `vouch`; `invites_rail_supported` is dropped. A partial unique index allows one
redemption per vouch, and `require_vouch_recipient` triggers refuse vouch redemptions and
vouch-acquired signups whose contact differs from the invite's intended contact. The contact is
unverified, so this simulates recipient matching rather than proving identity.

`011` replaces `is_demo_contact` with an explicit code-point exclusion list instead of
locale-dependent `\s`. The excluded points are controls, spaces, Unicode space separators,
zero-width and bidi formatting characters and the BOM. The API's `contact()` excludes the same
points, so a contact it accepts cannot fail the check and surface as a 500. Existing rows are not
revalidated. Like the other migrations, `010`/`011` add constraints and indexes in one transaction
without `NOT VALID`/`CONCURRENTLY`. That is acceptable at demo scale; a populated production
rollout would need staged validation, which is a follow-up.

`012` adds the `metric_invite_open_units` view: one deduplicated `(invite, guest journey)`
first open per unit with its rail, platform, displayed state, recovery flag and the
earlier-of-24h/activity-start claim deadline, plus whether an attributed `spot_claimed`
landed inside it. Runtime receives SELECT on the view only; it changes no historical data.
The metrics endpoints (`/api/metrics/summary`, `/api/metrics/product`) read it together
with `booking_reconciliation`, `analytics_events`, bookings/invites/users and
`experiment_assignments`.
