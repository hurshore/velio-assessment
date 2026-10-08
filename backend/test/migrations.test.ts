import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { discoverMigrations, runMigrations } from '../src/migrations.js';

test('discovers padded migration numbers in order and rejects ambiguous files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'velio-migrations-'));
  try {
    await writeFile(join(directory, '010_second.sql'), 'SELECT 10');
    await writeFile(join(directory, '009_first.sql'), 'SELECT 9');
    await writeFile(join(directory, 'README.md'), 'Notes');
    assert.deepEqual(await discoverMigrations(directory), ['009_first.sql', '010_second.sql']);
    await writeFile(join(directory, '9_unpadded.sql'), 'SELECT 9');
    await assert.rejects(discoverMigrations(directory), /NNN_description.sql.*9_unpadded.sql/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});


test('preserves the original SQL error even if rollback and connection cleanup fail', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'velio-recovery-'));
  const original = new Error('failing migration statement');
  const reported: Array<{ context: Record<string, string>; error: unknown }> = [];
  try {
    await writeFile(join(directory, '001_failure.sql'), 'SELECT broken');
    const client = {
      connect: async () => {}, end: async () => { throw new Error('close failed'); },
      query: async (sql: string) => {
        if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: true }], rowCount: 1 };
        if (sql === 'SELECT broken') throw original;
        if (sql === 'ROLLBACK') throw new Error('rollback failed');
        return { rows: [], rowCount: 0 };
      },
    };
    await assert.rejects(runMigrations(client, directory, (context, error) => reported.push({ context, error })), error => error === original);
    assert.ok(reported.some(entry => entry.context.file === '001_failure.sql' && entry.error === original));
    assert.ok(reported.some(entry => entry.context.operation === 'rollback'));
    assert.ok(reported.some(entry => entry.context.operation === 'close'));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('an occupied migration lock fails clearly before applying schema changes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'velio-lock-'));
  let closed = false;
  try {
    const client = { connect: async () => {}, end: async () => { closed = true; },
      query: async (sql: string) => {
        if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: false }], rowCount: 1 };
        throw new Error('Schema must not change when another migration run is active');
      },
    };
    await assert.rejects(runMigrations(client, directory), /Another migration run is active/);
    assert.equal(closed, true);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('duplicate migration numbers cannot create ambiguous ordering', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'velio-duplicate-'));
  try {
    await writeFile(join(directory, '001_first.sql'), 'SELECT 1');
    await writeFile(join(directory, '001_second.sql'), 'SELECT 2');
    await assert.rejects(discoverMigrations(directory), /Duplicate migration number: 001/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
