import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { before, after, test } from 'node:test';
import { createApp } from '../src/app.js';
import { defaultInviteConfig, requireInviteCreation } from '../src/experiments.js';
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
  server = createApp({ postgres: runtime, redis: { ping: async () => 'PONG' } }, 'http://localhost:5173').listen(0, '127.0.0.1');
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
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID(), ...(actor ? { 'X-Demo-Actor-Id': actor } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, ...await response.json() };
}


const input = { title: 'Experiment fixture', description: 'Synthetic cohort', meetingLocation: 'Test gate',
  startsAt: '2030-01-15T07:00:00Z', timezone: 'Africa/Lagos', capacity: 4, priceMinor: 0, currency: 'NGN' };
async function identity() {
  return (await request('/identities', { displayName: 'Experiment actor', journeyId: randomUUID(), platform: 'web', test: true })).data.id;
}
async function restart(version: string, treatmentPercent: number, creationEnabled = true) {
  await new Promise<void>(resolve => server.close(() => resolve()));
  server = createApp({ postgres: runtime, redis: { ping: async () => 'PONG' }, invites: { version, treatmentPercent, creationEnabled } }, 'http://localhost:5173').listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
}
test('assignment survives restart and rollout changes without requiring exposure', async () => {
  await restart('cohort-a', 100);
  const actor = await identity();
  const activity = (await request('/activities', input, actor)).data;
  assert.equal(activity.assignment.variant, 'treatment');
  assert.equal(activity.assignment.version, 'cohort-a');
  assert.equal(activity.assignment.treatmentPercent, 100);
  await restart('cohort-b', 0, false);
  assert.deepEqual((await request(`/activities/${activity.id}`)).data.assignment, activity.assignment);
  assert.equal((await request(`/activities/${activity.id}`)).data.inviteCreationEnabled, false);
  const next = (await request('/activities', input, actor)).data;
  assert.equal(next.assignment.variant, 'control');
  assert.equal(next.assignment.version, 'cohort-b');
  assert.equal((await owner.query("SELECT count(*)::int AS n FROM analytics_events WHERE name='experiment_exposed'")).rows[0].n, 0);
  await assert.rejects(runtime.query('UPDATE experiment_assignments SET version=$1 WHERE activity_id=$2', ['replacement', activity.id]), /permission denied/);
  await assert.rejects(runtime.query('DELETE FROM experiment_assignments WHERE activity_id=$1', [activity.id]), /permission denied/);
});

test('labelled treatment/control seeds are repeatable and bookable with server-derived event context', async () => {
  await owner.query(await readFile(new URL('../seeds/host.sql', import.meta.url), 'utf8'));
  const seed = await readFile(new URL('../seeds/experiments.sql', import.meta.url), 'utf8');
  await owner.query(seed); await owner.query(seed);
  const actor = await identity();
  for (const [id, variant] of [['b4000000-0000-4000-8000-000000000001', 'treatment'], ['b4000000-0000-4000-8000-000000000002', 'control']]) {
    const activity = (await request(`/activities/${id}`)).data;
    assert.equal(activity.assignment.variant, variant);
    const booking = await request(`/activities/${id}/bookings`, { platform: 'web', journeyId: randomUUID() }, actor);
    assert.equal(booking.status, 201);
    const stored = (await owner.query("SELECT context FROM analytics_events WHERE booking_id=$1 AND name='booking_succeeded'", [booking.data.booking.id])).rows[0];
    assert.deepEqual(stored.context.assignment, activity.assignment);
  }
});

test('creation policy requires treatment, enabled creation and a host or confirmed booker', async () => {
  await restart('policy', 100);
  const host = await identity();
  const outsider = await identity();
  const activity = (await request('/activities', input, host)).data;
  const path = `/activities/${activity.id}/invite-eligibility`;
  assert.equal((await request(path, undefined, host)).data.allowed, true);
  assert.equal((await request(path)).data.reason, 'host_or_booker_required');
  assert.equal((await request(path, undefined, outsider)).data.allowed, false);
  await assert.rejects(requireInviteCreation(runtime, activity.id, outsider, true), /New invitations/);
  assert.equal((await request(`/activities/${activity.id}/bookings`, { platform: 'web', journeyId: randomUUID() }, outsider)).status, 201);
  assert.equal((await request(path, undefined, outsider)).data.allowed, true);
  await restart('policy-next', 0, false);
  assert.equal((await request(path, undefined, host)).data.reason, 'creation_disabled');
  assert.equal((await request(path, undefined, outsider)).data.allowed, false);
  await assert.rejects(requireInviteCreation(runtime, activity.id, host, false), /New invitations/);
  const control = (await request('/activities', input, host)).data;
  await restart('policy-next', 0, true);
  assert.equal((await request(`/activities/${control.id}/invite-eligibility`, undefined, host)).data.reason, 'control');
  assert.equal((await request(`/activities/${control.id}/bookings`, { platform: 'web', journeyId: randomUUID() }, outsider)).status, 201);
});

test('rendered exposure is deduplicated and derives persisted assignment instead of client attribution', async () => {
  const host = await identity();
  const activity = (await request('/activities', input, host)).data;
  const exposure = { id: randomUUID(), schemaVersion: 1, name: 'experiment_exposed', occurredAt: new Date().toISOString(),
    source: 'client', platform: 'web', journeyId: randomUUID(), activityId: activity.id, planId: activity.planId };
  assert.equal((await request('/events', exposure)).data.accepted, true);
  await restart('changed', 100, false);
  assert.equal((await request('/events', exposure)).data.accepted, false);
  const events = (await owner.query('SELECT context FROM analytics_events WHERE id=$1', [exposure.id])).rows;
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].context.assignment, activity.assignment);
  assert.equal((await request('/events', { ...exposure, id: randomUUID(), assignment: { variant: 'treatment' } })).status, 400);
});

test('assignment insertion failure rolls back the activity and sole plan', async () => {
  await owner.query(`CREATE FUNCTION reject_assignment() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Injected assignment failure'; END $$;
    CREATE TRIGGER reject_assignment BEFORE INSERT ON experiment_assignments FOR EACH ROW EXECUTE FUNCTION reject_assignment()`);
  const actor = await identity();
  try {
    assert.equal((await request('/activities', input, actor)).status, 500);
    assert.equal((await owner.query('SELECT count(*)::int AS n FROM activities WHERE host_id=$1', [actor])).rows[0].n, 0);
    assert.equal((await owner.query('SELECT count(*)::int AS n FROM plans p LEFT JOIN activities a ON a.id=p.activity_id WHERE a.id IS NULL')).rows[0].n, 0);
  } finally { await owner.query('DROP TRIGGER reject_assignment ON experiment_assignments; DROP FUNCTION reject_assignment()'); }
});
