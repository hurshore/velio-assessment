# SQL migrations

`npm run migrate` uses only `MIGRATION_DATABASE_URL`, serializes runners with a PostgreSQL advisory lock, and applies sorted `NNN_description.sql` files in individual transactions. Applied filenames are recorded in `schema_migrations`; never edit an applied migration. Run from the backend workspace via the root command.

The foundation intentionally has no domain migrations or seeds. The runner creates only its migration ledger. Feature tickets add their schema, explicit runtime grants, immutable-history guards, and labelled seeds. The runtime role starts with connection access and no schema creation or domain table permissions.
