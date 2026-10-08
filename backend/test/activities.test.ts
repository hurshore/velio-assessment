import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { readFile } from 'node:fs/promises';
import { before, after, test } from 'node:test';
import pg from 'pg';
import { loadInviteConfig } from '../src/experiments.js';
import { createApp } from '../src/app.js';
import { runMigrations } from '../src/migrations.js';

// Each run owns a new database; no demo data is removed by these checks.
const name = `velio_test_${randomUUID().replaceAll('-', '')}`;
const admin = new pg.Client({ connectionString: process.env.MIGRATION_DATABASE_URL });
let owner: pg.Pool;
let runtime: pg.Pool;
let server: ReturnType<ReturnType<typeof createApp>['listen']>;
let base: string;
before(async () => {
  assert.ok(process.env.MIGRATION_DATABASE_URL && process.env.DATABASE_URL, 'Run npm run setup and npm run infra:up first');
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  function url(value: string) { const url = new URL(value); url.pathname = `/${name}`; return url.href; }
  const migrationUrl = url(process.env.MIGRATION_DATABASE_URL!);
  await runMigrations(new pg.Client({ connectionString: migrationUrl }), new URL('../migrations/', import.meta.url).pathname);
  owner = new pg.Pool({ connectionString: migrationUrl });
  runtime = new pg.Pool({ connectionString: url(process.env.DATABASE_URL!) });
  server = createApp({ invites: loadInviteConfig({}), postgres: runtime, redis: { ping: async () => 'PONG' } }, 'http://localhost:5173').listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
});
after(async () => {
  if (server) await new Promise<void>(resolve => server.close(() => resolve()));
  await runtime?.end(); await owner?.end();
  await admin.query(`DROP DATABASE IF EXISTS ${name}`);
  await admin.end();
});
async function request(path: string, body?: unknown, actor?: string) {
  const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', ...(actor ? { 'X-Demo-Actor-Id': actor } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, ...await response.json() };
}

test('organic demo identity survives selection and records initial acquisition', async () => {
  const created = await request('/identities', { displayName: 'Organic host', journeyId: randomUUID(), platform: 'web', synthetic: true, test: true });
  assert.equal(created.status, 201);
  assert.equal(created.data.generation, 0);
  assert.equal(created.data.acquisitionRootId, created.data.id);
  assert.equal(created.data.acquisitionParentId, null);
  assert.equal((await request(`/identities/${created.data.id}`)).data.displayName, 'Organic host');
  assert.ok((await request('/identities')).data.some((user: { id: string }) => user.id === created.data.id));
});

const activityInput = { title: 'Sunrise walk', description: 'An easy walk by the water.', meetingLocation: 'Marina gate',
  startsAt: '2030-01-15T07:00:00Z', timezone: 'Africa/Lagos', capacity: 2, priceMinor: 1500, currency: 'NGN' };
test('host creates one shared plan without consuming a seat and can discover and inspect it', async () => {
  const user = await request('/identities', { displayName: 'Activity host', journeyId: randomUUID(), platform: 'web', test: true });
  const created = await request('/activities', activityInput, user.data.id);
  assert.equal(created.status, 201);
  assert.equal(created.data.remainingSeats, 2);
  assert.equal(created.data.confirmedCount, 0);
  assert.equal(created.data.priceMinor, 1500);
  assert.equal(created.data.timezone, 'Africa/Lagos');
  assert.deepEqual(created.data.participants, []);
  const detail = await request(`/activities/${created.data.id}`);
  assert.equal(detail.data.planId, created.data.planId);
  assert.deepEqual(detail.data.participants, []);
  assert.ok((await request('/activities')).data.some((activity: { id: string }) => activity.id === created.data.id));
  const plans = await owner.query('SELECT id FROM plans WHERE activity_id=$1', [created.data.id]);
  assert.equal(plans.rowCount, 1);
  await assert.rejects(owner.query('INSERT INTO plans (activity_id) VALUES ($1)', [created.data.id]), /unique/);
});

test('API rejects invalid activity fields and unidentified hosts without persisting activities', async () => {
  const user = await request('/identities', { displayName: 'Validation host', journeyId: randomUUID(), platform: 'web', test: true });
  for (const patch of [ { title: ' ' }, { description: '' }, { meetingLocation: '' }, { capacity: 0 }, { capacity: 1.5 },
    { priceMinor: -1 }, { priceMinor: 0.5 }, { currency: '' }, { currency: 'ngn' }, { timezone: 'CST' },
    { timezone: 'Made/Up' }, { startsAt: '2030-01-15T07:00:00' }, { startsAt: '2030-02-30T07:00:00Z' },
    { startsAt: '2030-01-15T24:00:00Z' }, { hostId: user.data.id } ]) {
    const response = await request('/activities', { ...activityInput, ...patch }, user.data.id);
    assert.equal(response.status, 400, JSON.stringify(patch));
    assert.equal(response.error.code, 'INVALID_REQUEST');
  }
  assert.equal((await request('/activities', activityInput)).status, 401);
  assert.equal((await request('/activities', activityInput, randomUUID())).status, 401);
  const count = await owner.query('SELECT count(*)::int AS count FROM activities WHERE host_id=$1', [user.data.id]);
  assert.equal(count.rows[0].count, 0);
});

test('runtime role can change display name but cannot rewrite or delete acquisition history', async () => {
  const user = await request('/identities', { displayName: 'Original', journeyId: randomUUID(), platform: 'web', test: true });
  await runtime.query('UPDATE users SET display_name=$1 WHERE id=$2', ['Renamed', user.data.id]);
  assert.equal((await request(`/identities/${user.data.id}`)).data.displayName, 'Renamed');
  for (const sql of ['UPDATE users SET generation=1 WHERE id=$1', 'UPDATE users SET acquisition_root_id=$1 WHERE id=$1',
    'DELETE FROM users WHERE id=$1', 'UPDATE signup_attribution SET generation=1 WHERE user_id=$1', 'DELETE FROM signup_attribution WHERE user_id=$1']) {
    await assert.rejects(runtime.query(sql, [user.data.id]), /permission denied/);
  }
  const events = await owner.query("SELECT * FROM analytics_events WHERE actor_id=$1 AND name='identity_created'", [user.data.id]);
  assert.equal(events.rowCount, 1);
  assert.equal(events.rows[0].source, 'server');
  assert.equal(events.rows[0].test, true);
});

test('rendered activity event ingestion is durable, deduplicated and validates trusted context', async () => {
  const user = await request('/identities', { displayName: 'Event host', journeyId: randomUUID(), platform: 'web', synthetic: true, test: true });
  const activity = await request('/activities', activityInput, user.data.id);
  const event = { id: randomUUID(), schemaVersion: 1, name: 'activity_viewed', occurredAt: '2030-01-01T12:00:00Z',
    source: 'client', platform: 'mobile', actorId: user.data.id, journeyId: randomUUID(), activityId: activity.data.id,
    planId: activity.data.planId, synthetic: false, test: false };
  assert.equal((await request('/events', event, user.data.id)).data.accepted, true);
  assert.equal((await request('/events', event, user.data.id)).data.accepted, false);
  const stored = await owner.query('SELECT * FROM analytics_events WHERE id=$1', [event.id]);
  assert.equal(stored.rowCount, 1);
  assert.equal(stored.rows[0].platform, 'mobile');
  assert.equal(stored.rows[0].journey_id, event.journeyId);
  assert.equal(stored.rows[0].plan_id, activity.data.planId);
  assert.equal(stored.rows[0].synthetic, true);
  assert.equal(stored.rows[0].test, true);
  for (const patch of [{ schemaVersion: 2 }, { name: 'identity_created' }, { source: 'server' }, { generation: 42 },
    { rail: 'public' }, { platform: 'bot' }, { synthetic: 'true' }, { occurredAt: 'bad' }, { activityId: randomUUID() },
    { planId: randomUUID() }, { actorId: randomUUID() }, { id: 'bad' }]) {
    assert.ok((await request('/events', { ...event, id: randomUUID(), ...patch }, user.data.id)).status >= 400, JSON.stringify(patch));
  }
  const anonymous = { ...event, id: randomUUID(), actorId: undefined, planId: undefined };
  assert.equal((await request('/events', anonymous)).status, 202);
  assert.equal((await request('/events', { ...anonymous, id: randomUUID(), journeyId: undefined })).status, 400);
});

test('database guards activity invariants and participants are read from confirmed bookings', async () => {
  const user = await request('/identities', { displayName: 'Membership fixture', journeyId: randomUUID(), platform: 'web', test: true });
  const activity = await request('/activities', activityInput, user.data.id);
  const id = activity.data.id;
  for (const statement of ['UPDATE activities SET capacity=0 WHERE id=$1', 'UPDATE activities SET price_minor=-1 WHERE id=$1',
    "UPDATE activities SET timezone='Made/Up' WHERE id=$1", "UPDATE activities SET currency='' WHERE id=$1", 'UPDATE activities SET confirmed_count=3 WHERE id=$1']) {
    await assert.rejects(owner.query(statement, [id]), /check constraint/);
  }
  await assert.rejects(runtime.query('DELETE FROM plans WHERE activity_id=$1', [id]), /permission denied/);
  const connection = await owner.connect();
  try {
    await connection.query('BEGIN');
    await connection.query('INSERT INTO bookings (activity_id,plan_id,user_id,price_minor,currency) VALUES ($1,$2,$3,1500,\'NGN\')', [id, activity.data.planId, user.data.id]);
    await connection.query('UPDATE activities SET confirmed_count=1,version=2 WHERE id=$1', [id]);
    await connection.query('COMMIT');
  } finally { connection.release(); }
  const detail = await request(`/activities/${id}`);
  assert.deepEqual(detail.data.participants, [{ id: user.data.id, displayName: 'Membership fixture' }]);
  assert.equal(detail.data.remainingSeats, 1);
  assert.equal(detail.data.version, 2);
});

test('labelled seeds can be replayed without changing plans or duplicating signup events', async () => {
  const sql = await readFile(new URL('../seeds/host.sql', import.meta.url), 'utf8');
  const client = await owner.connect();
  try { await client.query(sql); await client.query(sql); } finally { client.release(); }
  const activity = await request('/activities/b1000000-0000-4000-8000-000000000001');
  assert.equal(activity.data.remainingSeats, 2);
  assert.deepEqual(activity.data.participants, []);
  assert.equal((await request('/identities/a1000000-0000-4000-8000-000000000001')).data.synthetic, true);
  const events = await owner.query("SELECT count(*)::int AS count FROM analytics_events WHERE id IN ('e1000000-0000-4000-8000-000000000001','e1000000-0000-4000-8000-000000000002')");
  assert.equal(events.rows[0].count, 2);
});

test('anonymous seed activity views retain synthetic markers', async () => {
  const id = randomUUID();
  const response = await request('/events', { id, schemaVersion: 1, name: 'activity_viewed', occurredAt: new Date().toISOString(),
    source: 'client', platform: 'web', journeyId: randomUUID(), activityId: 'b1000000-0000-4000-8000-000000000001' });
  assert.equal(response.status, 202);
  const event = await owner.query('SELECT synthetic FROM analytics_events WHERE id=$1', [id]);
  assert.equal(event.rows[0].synthetic, true);
});

test('timezone input resolves to a database-supported display zone before insertion', async () => {
  const user = await request('/identities', { displayName: 'Timezone regressions', journeyId: randomUUID(), platform: 'web', test: true });
  for (const timezone of ['Africa/Lagos', 'africa/lagos']) {
    const created = await request('/activities', { ...activityInput, timezone }, user.data.id);
    assert.equal(created.status, 201, timezone);
    assert.equal(created.data.timezone, 'Africa/Lagos');
    const stored = await owner.query('SELECT timezone, valid_display_timezone(timezone) AS supported FROM activities WHERE id=$1', [created.data.id]);
    assert.equal(stored.rows[0].timezone, 'Africa/Lagos');
    assert.equal(stored.rows[0].supported, true);
    const detail = await request(`/activities/${created.data.id}`);
    assert.equal(new Intl.DateTimeFormat('en-GB', { timeZone: detail.data.timezone, hour: '2-digit', minute: '2-digit' }).format(new Date(detail.data.startsAt)), '08:00');
  }
  const invalid = await request('/activities', { ...activityInput, timezone: 'Invalid/Zone' }, user.data.id);
  assert.equal(invalid.status, 400);
  assert.equal(invalid.error.code, 'INVALID_REQUEST');
  assert.equal(invalid.error.retryable, false);
  assert.match(invalid.error.message, /timezone/i);
});
