import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { runMigrations } from './migrations.js';

const migrationTimeoutMs = 3000;
const connectionString = process.env.MIGRATION_DATABASE_URL;
if (!connectionString) throw new Error('MIGRATION_DATABASE_URL is required; fill the missing entry in .env and preserve existing credentials.');
const client = new pg.Client({ connectionString, connectionTimeoutMillis: migrationTimeoutMs, query_timeout: migrationTimeoutMs, statement_timeout: migrationTimeoutMs });
await runMigrations(client, fileURLToPath(new URL('../migrations/', import.meta.url)));
