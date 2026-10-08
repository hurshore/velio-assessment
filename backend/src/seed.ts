import { readFile } from 'node:fs/promises';
import pg from 'pg';
const connectionString = process.env.MIGRATION_DATABASE_URL;
if (!connectionString) throw new Error('MIGRATION_DATABASE_URL is required for labelled seeds.');
const client = new pg.Client({ connectionString });
try {
  await client.connect();
  await client.query(await readFile(new URL('../seeds/host.sql', import.meta.url), 'utf8'));
  console.log('Seeded organic demo hosts and paid/free activities (synthetic, repeatable).');
} finally { await client.end(); }
