import { reportFailure, type FailureReporter } from './diagnostics.js';
import { readdir, readFile } from 'node:fs/promises';

export async function discoverMigrations(directory: string): Promise<string[]> {
  const files = (await readdir(directory)).filter(name => name.toLowerCase().endsWith('.sql'));
  const numbers = new Set<string>();
  for (const name of files) {
    if (!/^\d{3}_[\w-]+\.sql$/.test(name)) throw new Error(`Migration filenames must use NNN_description.sql: ${name}`);
    const number = name.slice(0, 3);
    if (numbers.has(number)) throw new Error(`Duplicate migration number: ${number}`);
    numbers.add(number);
  }
  return files.sort();
}

export interface MigrationConnection {
  connect(): Promise<unknown>;
  query(sql: string, parameters?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
  end(): Promise<void>;
}

export async function runMigrations(client: MigrationConnection, directory: string, logFailure: FailureReporter = reportFailure): Promise<void> {
  const files = await discoverMigrations(directory);
  let failed = false;
  try {
    await client.connect();
    // A second runner fails immediately rather than waiting behind a stuck session.
    const lock = await client.query('SELECT pg_try_advisory_lock(8241001) AS locked');
    if (lock.rows[0]?.locked !== true) throw new Error('Another migration run is active; retry after it finishes.');
    if (process.env.RUNTIME_DB_USER) await client.query("SELECT set_config('velio.runtime_role', $1, false)", [process.env.RUNTIME_DB_USER]);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    for (const name of files) {
      const applied = await client.query('SELECT 1 FROM schema_migrations WHERE name = $1', [name]);
      if (applied.rowCount) continue;
      await client.query('BEGIN');
      try {
        await client.query(await readFile(`${directory}/${name}`, 'utf8'));
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [name]);
        await client.query('COMMIT');
        console.log(`Applied ${name}`);
      } catch (error) {
        logFailure({ component: 'migration', file: name }, error);
        try { await client.query('ROLLBACK'); }
        catch (rollbackError) { logFailure({ component: 'migration', file: name, operation: 'rollback' }, rollbackError); }
        throw error;
      }
    }
    console.log('Migrations are current.');
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    try { await client.end(); }
    catch (error) {
      logFailure({ component: 'migration', operation: 'close' }, error);
      if (!failed) throw error;
    }
  }
}
