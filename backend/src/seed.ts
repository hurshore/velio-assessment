import { readFile } from 'node:fs/promises';
import pg from 'pg';
const connectionString = process.env.MIGRATION_DATABASE_URL;
if (!connectionString) throw new Error('MIGRATION_DATABASE_URL is required for labelled seeds.');
const client = new pg.Client({ connectionString });
try {
  await client.connect();
  await client.query(await readFile(new URL('../seeds/host.sql', import.meta.url), 'utf8'));
  await client.query(await readFile(new URL('../seeds/bookings.sql', import.meta.url), 'utf8'));
  await client.query(await readFile(new URL('../seeds/experiments.sql', import.meta.url), 'utf8'));
  await client.query(await readFile(new URL('../seeds/invites.sql', import.meta.url), 'utf8'));
  console.log('Seeded treatment/control invitation cohorts, organic demo hosts, paid/free and started/cancelled activities, and a public-link attribution chain (synthetic, repeatable).');
} finally { await client.end(); }
