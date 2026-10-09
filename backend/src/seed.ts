import pg from 'pg';
import { applySeeds } from './seed-files.js';
const connectionString = process.env.MIGRATION_DATABASE_URL;
if (!connectionString) throw new Error('MIGRATION_DATABASE_URL is required for labelled seeds.');
const client = new pg.Client({ connectionString });
try {
  await client.connect();
  await applySeeds(client);
  console.log('Seeded treatment/control invitation cohorts, organic demo hosts, paid/free and started/cancelled activities, a public-link attribution chain, and a labelled product-metric demonstration (synthetic, repeatable).');
} finally { await client.end(); }
