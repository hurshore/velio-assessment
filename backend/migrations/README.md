# SQL migrations

`npm run migrate` uses only `MIGRATION_DATABASE_URL`, uses an immediate PostgreSQL advisory try-lock (an occupied lock reports “Another migration run is active”), and applies sorted `NNN_description.sql` files in individual transactions. SQL filenames must have exactly three digits (`001_description.sql`), and duplicate number prefixes are rejected before database work. Driver/statement deadlines are 3 seconds; long migrations must deliberately adjust that local runner budget. Applied filenames are recorded in `schema_migrations`; never edit an applied migration. Run from the backend workspace via the root command.

The foundation intentionally has no domain migrations or seeds. The runner creates only its migration ledger. Feature tickets add their schema, explicit runtime grants, immutable-history guards, and labelled seeds. The runtime role starts with connection access and no schema creation or domain table permissions.

Migration failures retain the original error and log the filename. Rollback/connection-close failures are reported separately and never replace the original failure.

Host migrations require `RUNTIME_DB_USER` naming the existing runtime login. The runner sets `velio.runtime_role` for SQL grants after obtaining its migration lock. `001` owns organic identity/acquisition/event storage; `002` owns activities, a database-created unique plan and read-only confirmed membership. `npm run seed` adds repeatable synthetic host scenarios using migration credentials; it is separate from schema migration and never resets existing data.
