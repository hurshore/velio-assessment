import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp, readdir, copyFile, rm, readFile } from 'node:fs/promises';
import { before, after, test } from 'node:test';
import pg from 'pg';
import { createApp } from '../src/app.js';
import { loadInviteConfig, createInvitePolicy } from '../src/experiments.js';
import { runMigrations } from '../src/migrations.js';

// Each run owns a new database; no demo data is removed by these checks.
const name = `velio_test_${randomUUID().replaceAll('-', '')}`;
const admin = new pg.Client({ connectionString: process.env.MIGRATION_DATABASE_URL });
let owner: pg.Pool;
let runtime: pg.Pool;
let server: ReturnType<ReturnType<typeof createApp>['listen']>;
let base: string;
const legacyId = 'b9000000-0000-4000-8000-000000000001';
before(async () => {
  assert.ok(process.env.MIGRATION_DATABASE_URL && process.env.DATABASE_URL, 'Run npm run setup and npm run infra:up first');
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  function url(value: string) { const url = new URL(value); url.pathname = `/${name}`; return url.href; }
  const migrationUrl = url(process.env.MIGRATION_DATABASE_URL!);
  const directory = new URL('../migrations/', import.meta.url).pathname;
  const early = await mkdtemp(join(tmpdir(), 'velio-pre-assignment-'));
  try {
    for (const file of (await readdir(directory)).filter(file => file.slice(0, 3) < '005')) await copyFile(join(directory, file), join(early, file));
    await runMigrations(new pg.Client({ connectionString: migrationUrl }), early);
  } finally { await rm(early, { recursive: true, force: true }); }
  owner = new pg.Pool({ connectionString: migrationUrl });
  const actor = randomUUID();
  await owner.query("INSERT INTO users (id,display_name,generation,acquisition_root_id,test) VALUES ($1,'Legacy fixture',0,$1,true)", [actor]);
  await owner.query(`INSERT INTO activities (id,host_id,title,description,meeting_location,starts_at,timezone,capacity,price_minor,currency)
    VALUES ($1,$2,'Pre-assignment fixture','Backfill fixture','Test gate','2030-01-15','UTC',4,0,'NGN')`, [legacyId, actor]);
  await runMigrations(new pg.Client({ connectionString: migrationUrl }), directory);
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
  assert.equal((await request(`/activities/${activity.id}`)).data.invitePolicy.creationEnabled, false);
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
  await assert.rejects(createInvitePolicy(runtime, {version:'policy', treatmentPercent:100, creationEnabled:true}).requireCreation(activity.id, outsider), /New invitations/);
  assert.equal((await request(`/activities/${activity.id}/bookings`, { platform: 'web', journeyId: randomUUID() }, outsider)).status, 201);
  assert.equal((await request(path, undefined, outsider)).data.allowed, true);
  await restart('policy-next', 0, false);
  assert.equal((await request(path, undefined, host)).data.reason, 'creation_disabled');
  assert.equal((await request(path, undefined, outsider)).data.allowed, false);
  await assert.rejects(createInvitePolicy(runtime, {version:'policy', treatmentPercent:100, creationEnabled:false}).requireCreation(activity.id, host), /New invitations/);
  const control = (await request('/activities', input, host)).data;
  await restart('policy-next', 0, true);
  assert.equal((await request(`/activities/${control.id}/invite-eligibility`, undefined, host)).data.reason, 'control');
  assert.equal((await request(`/activities/${control.id}/bookings`, { platform: 'web', journeyId: randomUUID() }, outsider)).status, 201);
});

test('rendered exposure is deduplicated and derives persisted assignment instead of client attribution', async () => {
  const host = await identity();
  const activity = (await request('/activities', input, host)).data;
  const exposure = { displayedInviteState: {enabled:false,creationEnabled:true,reason:'control'}, id: randomUUID(), schemaVersion: 1, name: 'experiment_exposed', occurredAt: new Date().toISOString(),
    source: 'client', platform: 'web', journeyId: randomUUID(), activityId: activity.id, planId: activity.planId };
  assert.equal((await request('/events', exposure)).data.accepted, true);
  await restart('changed', 100, false);
  assert.equal((await request('/events', exposure)).data.accepted, false);
  const events = (await owner.query('SELECT context FROM analytics_events WHERE id=$1', [exposure.id])).rows;
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].context.assignment, activity.assignment);
  assert.deepEqual(events[0].context.displayedInviteState, exposure.displayedInviteState);
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

test('client event ingestion rejects non-string names, including an exposure array', async () => {
  const actor = await identity();
  const activity = (await request('/activities', input, actor)).data;
  for (const name of [['experiment_exposed'], ['activity_viewed'], null, {}, 1, true]) {
    const event = { id: randomUUID(), schemaVersion: 1, name, occurredAt: new Date().toISOString(),
      source: 'client', platform: 'web', journeyId: randomUUID(), activityId: activity.id };
    const result = await request('/events', event);
    assert.equal(result.status, 400, JSON.stringify(name));
    assert.equal((await owner.query('SELECT count(*)::int AS n FROM analytics_events WHERE id=$1', [event.id])).rows[0].n, 0);
  }
});

test('every committed activity requires an explicit assignment and database verifies its bucket', async () => {
  const actor = await identity();
  const insert = `INSERT INTO activities (id,host_id,title,description,meeting_location,starts_at,timezone,capacity,price_minor,currency)
    VALUES ($1,$2,'Unassigned fixture','Invariant fixture','Test gate','2030-01-15','UTC',4,0,'NGN')`;
  const id = randomUUID();
  await assert.rejects(owner.query(insert, [id, actor]), /activities_invite_assignment_fk/);
  assert.equal((await request('/activities')).data.some((a: { id: string }) => a.id === id), false);
  const connection = await owner.connect();
  try {
    await connection.query('BEGIN');
    await connection.query(insert, [id, actor]);
    assert.equal((await connection.query('SELECT count(*)::int AS n FROM activities WHERE id=$1', [id])).rows[0].n, 1);
    await assert.rejects(connection.query('COMMIT'), /activities_invite_assignment_fk/);
    await connection.query('ROLLBACK');
    await connection.query('BEGIN');
    await connection.query(insert, [id, actor]);
    await connection.query("SELECT assign_invite_experiment($1,'explicit-fixture',50)", [id]);
    await connection.query('COMMIT');
    assert.equal((await request(`/activities/${id}`)).data.assignment.version, 'explicit-fixture');
  } finally { await connection.query('ROLLBACK'); connection.release(); }

});

test('eligibility rejects unknown demo actors separately from known ineligible actors', async () => {
  const host = await identity();
  const activity = (await request('/activities', input, host)).data;
  const response = await request(`/activities/${activity.id}/invite-eligibility`, undefined, randomUUID());
  assert.equal(response.status, 401);
  assert.equal(response.error.code, 'IDENTITY_REQUIRED');
});


test('migration backfills pre-existing activity without exposure and retains its assignment', async () => {
  const activity = (await request(`/activities/${legacyId}`)).data;
  assert.equal(activity.assignment.version, '1');
  assert.equal(activity.assignment.treatmentPercent, 50);
  assert.equal((await owner.query('SELECT count(*)::int AS n FROM experiment_assignments WHERE activity_id=$1', [legacyId])).rows[0].n, 1);
  assert.equal((await owner.query("SELECT count(*)::int AS n FROM analytics_events WHERE activity_id=$1 AND name='experiment_exposed'", [legacyId])).rows[0].n, 0);
  await restart('new-cohort', 90, false);
  assert.deepEqual((await request(`/activities/${legacyId}`)).data.assignment, activity.assignment);
});

test('middle allocation assigns both sides of threshold and leaves existing assignments stable', async () => {
  await owner.query(await readFile(new URL('../seeds/host.sql', import.meta.url), 'utf8'));
  await owner.query(await readFile(new URL('../seeds/experiments.sql', import.meta.url), 'utf8'));
  const ids = ['b4000000-0000-4000-8000-000000000001', 'b4000000-0000-4000-8000-000000000002'];
  const assignments = await Promise.all(ids.map(async id => (await request(`/activities/${id}`)).data.assignment));
  assert.deepEqual(assignments.map(a => a.treatmentPercent), [50, 50]);
  assert.deepEqual(assignments.map(a => a.variant), ['treatment', 'control']);
  assert.deepEqual((await owner.query('SELECT bucket FROM experiment_assignments WHERE activity_id=ANY($1::uuid[]) ORDER BY activity_id', [ids])).rows.map(row => row.bucket), [1619, 9277]);
  await restart('seed-3', 20);
  assert.deepEqual(await Promise.all(ids.map(async id => (await request(`/activities/${id}`)).data.assignment)), assignments);
});

test('ordinary treatment booking works when the bound creation policy is disabled', async () => {
  await restart('switch-off', 100, false);
  const host = await identity();
  const booker = await identity();
  const activity = (await request('/activities', input, host)).data;
  assert.equal(activity.assignment.variant, 'treatment');
  assert.equal(activity.invitePolicy.reason, 'creation_disabled');
  const result = await request(`/activities/${activity.id}/bookings`, {platform:'web',journeyId:randomUUID()}, booker);
  assert.equal(result.status, 201);
  assert.equal((await request(`/activities/${activity.id}/invite-eligibility`, undefined, booker)).data.allowed, false);
});

test('missing assignment never hides an activity and creation fails closed while booking works', async () => {
  const host = await identity();
  const activity = (await request('/activities', input, host)).data;
  // Simulate administrative corruption that normal runtime writes/constraints prohibit.
  await owner.query('ALTER TABLE activities DROP CONSTRAINT activities_invite_assignment_fk');
  await owner.query('DELETE FROM experiment_assignments WHERE activity_id=$1', [activity.id]);
  try {
    const detail = await request(`/activities/${activity.id}`, undefined, host);
    assert.equal(detail.status, 200);
    assert.equal(detail.data.assignment, null);
    assert.equal(detail.data.invitePolicy.reason, 'assignment_unavailable');
    assert.equal(detail.data.invitePolicy.allowed, false);
    assert.ok((await request('/activities')).data.some((a: { id: string }) => a.id === activity.id));
    assert.equal((await request(`/activities/${activity.id}/invite-eligibility`, undefined, host)).data.reason, 'assignment_unavailable');
    assert.equal((await request(`/activities/${activity.id}/bookings`, {platform:'web',journeyId:randomUUID()}, host)).status, 201);
    const view = await request('/events', { id:randomUUID(),schemaVersion:1,name:'activity_viewed',occurredAt:new Date().toISOString(),source:'client',platform:'web',journeyId:randomUUID(),activityId:activity.id });
    assert.equal(view.status, 202);
  } finally {
    await owner.query('SELECT assign_invite_experiment($1,$2,$3)', [activity.id,activity.assignment.version,activity.assignment.treatmentPercent]);
    await owner.query('ALTER TABLE activities ADD CONSTRAINT activities_invite_assignment_fk FOREIGN KEY (id) REFERENCES experiment_assignments(activity_id) DEFERRABLE INITIALLY DEFERRED');
  }
});


test('exposure requires valid display context and preserves reported state across switch changes', async () => {
  await restart('display-context',100,true);
  const host = await identity();
  const activity = (await request('/activities', input, host)).data;
  const event = { id:randomUUID(),schemaVersion:1,name:'experiment_exposed',occurredAt:new Date().toISOString(),source:'client',platform:'web',journeyId:randomUUID(),activityId:activity.id,
    displayedInviteState:{enabled:true,creationEnabled:true,reason:'allowed'} };
  for (const displayedInviteState of [undefined,null,{},[],{enabled:'true',creationEnabled:true,reason:'allowed'},
    {enabled:true,reason:'allowed'},{enabled:true,creationEnabled:false,reason:'allowed'},
    {enabled:false,creationEnabled:true,reason:['control']},{enabled:false,creationEnabled:true,reason:'typo'}]) {
    assert.equal((await request('/events',{...event,id:randomUUID(),displayedInviteState})).status,400);
  }
  await restart('display-context',100,false);
  assert.equal((await request('/events',event)).status,202);
  const stored = (await owner.query('SELECT context FROM analytics_events WHERE id=$1',[event.id])).rows[0].context;
  assert.deepEqual(stored.displayedInviteState,event.displayedInviteState);
  assert.deepEqual(stored.assignment,activity.assignment);
  assert.equal((await request('/events',event)).data.accepted,false);
});

test('database independently rejects a hash mismatch even when variant matches the supplied bucket', async () => {
  await assert.rejects(owner.query(`UPDATE experiment_assignments SET bucket=1618 WHERE activity_id='b4000000-0000-4000-8000-000000000001'`), /invite_assignment_bucket_matches/);
  assert.equal((await owner.query("SELECT bucket FROM experiment_assignments WHERE activity_id='b4000000-0000-4000-8000-000000000001'")).rows[0].bucket,1619);
});

test('all six labelled fixtures replay without changing assignment history', async () => {
  for(const file of ['host.sql','bookings.sql','experiments.sql']) await owner.query(await readFile(new URL(`../seeds/${file}`,import.meta.url),'utf8'));
  const ids=['b1000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000002','b3000000-0000-4000-8000-000000000001','b3000000-0000-4000-8000-000000000002','b4000000-0000-4000-8000-000000000001','b4000000-0000-4000-8000-000000000002'];
  const snapshot=(await owner.query('SELECT * FROM experiment_assignments WHERE activity_id=ANY($1::uuid[]) ORDER BY activity_id',[ids])).rows;
  assert.equal(snapshot.length,6);
  for(const file of ['host.sql','bookings.sql','experiments.sql']) await owner.query(await readFile(new URL(`../seeds/${file}`,import.meta.url),'utf8'));
  assert.deepEqual((await owner.query('SELECT * FROM experiment_assignments WHERE activity_id=ANY($1::uuid[]) ORDER BY activity_id',[ids])).rows,snapshot);
});
