# SQL migrations

`npm run migrate` connects using `MIGRATION_DATABASE_URL`, uses an immediate PostgreSQL advisory try-lock (an occupied lock reports “Another migration run is active”), and applies sorted `NNN_description.sql` files in individual transactions. SQL filenames must have exactly three digits (`001_description.sql`), and duplicate number prefixes are rejected before database work. Driver/statement deadlines are 3 seconds; long migrations must deliberately adjust that local runner budget. Applied filenames are recorded in `schema_migrations`; never edit an applied migration. Run from the backend workspace via the root command.

The runner maintains its migration ledger and applies the host domain migrations: organic identities and acquisition history, activity/view events, activities, unique shared plans, and confirmed membership reads. These migrations include explicit runtime grants and immutable-history guards; labelled development seeds run separately. The bootstrap runtime role starts with connection access and no schema creation or domain table permissions; migrations grant only the operations this slice needs.

Migration failures retain the original error and log the filename. Rollback/connection-close failures are reported separately and never replace the original failure.

Host migrations require `RUNTIME_DB_USER` naming the existing runtime login. The runner sets `velio.runtime_role` for SQL grants after obtaining its migration lock. `001` owns organic identity/acquisition/event storage; `002` owns activities, a database-created unique plan and read-only confirmed membership. `npm run seed` adds repeatable synthetic host scenarios using migration credentials; it is separate from schema migration and never resets existing data.

`003` adds actor/operation-scoped booking keys, a durable availability outbox and independent `booking_reconciliation` view; grants runtime INSERT on bookings and UPDATE only on activity count/version, key results and outbox delivery state. Bookings remain immutable to the runtime role. Redis dispatch is owned by #7.

`004` adds `bookings(activity_id) INCLUDE (id)` to keep activity-scoped reconciliation and participant reads from scanning unrelated membership. The reconciliation view, row-lock ordering and capacity constraints are unchanged. A representative 100,000-booking plan comparison is captured in [the booking verification report](../../docs/verification/seat-booking.md).

`005` adds expiring outbox dispatch leases/retry scheduling, a booking-transaction origin process marker, durable gateway lifetimes, and live observation/delivery records. Runtime can insert observation denominators and delivery expectations, and update only gateway stop timestamps, issued snapshot versions and ACK timestamps/delays. Booking-owned payloads and immutable booking/referral history remain protected.
