import { readFile } from 'node:fs/promises';

// Applied in order by `npm run seed` and by the seed smoke test. Each file is idempotent.
export const seedFiles = ['host.sql', 'bookings.sql', 'experiments.sql', 'invites.sql', 'metrics.sql'];

export async function applySeeds(client: { query(sql: string): Promise<unknown> }) {
  for (const file of seedFiles) {
    await client.query(await readFile(new URL(`../seeds/${file}`, import.meta.url), 'utf8'));
  }
}
