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
  runtime = new pg.Pool({ connectionString: url(process.env.DATABASE_URL!), max: 60, connectionTimeoutMillis: 3000 });
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
async function request(path: string, body?: unknown, actor?: string, key?: string) {
  const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', ...(actor ? { 'X-Demo-Actor-Id': actor } : {}), ...(key ? { 'Idempotency-Key': key } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, ...await response.json() };
}

async function fixture(capacity = 2) {
  const actor = (await request('/identities', { displayName: 'Synthetic booker', journeyId: randomUUID(), platform: 'web', synthetic: true, test: true })).data.id;
  const activity = (await request('/activities', { title: 'Booking test', description: 'Synthetic capacity scenario', meetingLocation: 'Test gate',
    startsAt: '2030-01-15T07:00:00Z', timezone: 'Africa/Lagos', capacity, priceMinor: 1500, currency: 'NGN' }, actor)).data;
  return { actor, activity };
}
function book(activity: string, actor: string, key = randomUUID()) {
  return request(`/activities/${activity}/bookings`, { platform: 'web', journeyId: randomUUID() }, actor, key);
}
test('a committed seat has a price snapshot, plan membership and recoverable own confirmation', async () => {
  const { actor, activity } = await fixture();
  const result = await book(activity.id, actor);
  assert.equal(result.status, 201);
  assert.equal(result.data.booking.priceMinor, 1500);
  assert.equal(result.data.booking.planId, activity.planId);
  assert.equal(result.data.availability.remainingSeats, 1);
  assert.equal((await request(`/activities/${activity.id}/booking`, undefined, actor)).data.booking.id, result.data.booking.id);
  assert.deepEqual((await request(`/activities/${activity.id}`)).data.participants, [{ id: actor, displayName: 'Synthetic booker' }]);
});

test('independent membership reconciliation refuses a corrupt counter before allocating another seat', async () => {
  const { actor, activity } = await fixture();
  await owner.query('UPDATE activities SET confirmed_count=1 WHERE id=$1', [activity.id]);
  const result = await book(activity.id, actor);
  assert.equal(result.status, 500);
  assert.equal((await request(`/activities/${activity.id}/booking`, undefined, actor)).data.booking, null);
});

async function inspect(activityId: string, expected: number) {
  const detail = (await request(`/activities/${activityId}`)).data;
  assert.equal(detail.confirmedCount, expected);
  assert.equal(detail.participants.length, expected);
  assert.equal(detail.version, expected + 1);
  const state = (await owner.query(`SELECT * FROM booking_reconciliation WHERE activity_id=$1`, [activityId])).rows[0];
  assert.equal(state.booking_count, expected);
  assert.equal(state.counter_mismatch, false);
  assert.equal(state.oversold, false);
  for (const table of ['bookings', 'outbox_events']) {
    assert.equal((await owner.query(`SELECT count(*)::int AS n FROM ${table} WHERE activity_id=$1`, [activityId])).rows[0].n, expected);
  }
  assert.equal((await owner.query("SELECT count(*)::int AS n FROM analytics_events WHERE activity_id=$1 AND name='booking_succeeded'", [activityId])).rows[0].n, expected);
}
for (const seats of [1, 3]) {
  test(`50 coordinated distinct requests for ${seats} seats never oversell`, async () => {
    const { activity } = await fixture(seats);
    const actors = await Promise.all(Array.from({ length: 50 }, async () => (await request('/identities', {
      displayName: 'Synthetic race actor', journeyId: randomUUID(), platform: 'web', synthetic: true, test: true })).data.id));
    const lock = await owner.connect();
    await lock.query('BEGIN');
    await lock.query('SELECT id FROM activities WHERE id=$1 FOR UPDATE', [activity.id]);
    let release!: () => void;
    const start = new Promise<void>(resolve => { release = resolve; });
    const requests = actors.map(async actor => { await start; return book(activity.id, actor); });
    release();
    let overlap = 0;
    try {
      const deadline = Date.now() + 1000;
      while (Date.now() < deadline && overlap < 10) {
        overlap = (await owner.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=$1 AND wait_event_type='Lock'", [name])).rows[0].n;
        if (overlap < 10) await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.ok(overlap >= 10, `Expected overlapping transactions, saw ${overlap}`);
    } finally { await lock.query('ROLLBACK'); lock.release(); }
    const outcomes = await Promise.all(requests);
    assert.equal(outcomes.filter(result => result.status === 201).length, seats);
    assert.equal(outcomes.filter(result => result.status === 409 && result.error.code === 'SOLD_OUT').length, 50 - seats);
    await inspect(activity.id, seats);
  });
}

test('concurrent same and different keys consume one seat; mismatched payload is rejected', async () => {
  const { actor, activity } = await fixture(1);
  const key = randomUUID();
  const outcomes = await Promise.all(Array.from({ length: 10 }, () => book(activity.id, actor, key)));
  assert.equal(outcomes.filter(result => result.status === 201).length, 1);
  assert.equal(new Set(outcomes.map(result => result.data.booking.id)).size, 1);
  const retries = await Promise.all(Array.from({ length: 10 }, () => book(activity.id, actor)));
  assert.ok(retries.every(result => result.status === 200 && result.data.replayed));
  const other = await fixture();
  const mismatch = await book(other.activity.id, actor, key);
  assert.equal(mismatch.status, 409);
  assert.equal(mismatch.error.code, 'IDEMPOTENCY_MISMATCH');
  // Simulates losing the first response: persisted GET and original key both restore it.
  assert.equal((await request(`/activities/${activity.id}/booking`, undefined, actor)).data.booking.id, outcomes[0].data.booking.id);
  assert.equal((await book(activity.id, actor, key)).data.booking.id, outcomes[0].data.booking.id);
  await inspect(activity.id, 1);
  await inspect(other.activity.id, 0);
});

test('keys are scoped to actor, and existing bookings survive later cancellation and start', async () => {
  const { actor, activity } = await fixture();
  const key = randomUUID();
  const original = await book(activity.id, actor, key);
  const second = (await fixture()).actor;
  assert.equal((await book(activity.id, second, key)).status, 201);
  await owner.query("UPDATE activities SET status='cancelled',starts_at='2020-01-01' WHERE id=$1", [activity.id]);
  assert.equal((await book(activity.id, actor)).data.booking.id, original.data.booking.id);
  await inspect(activity.id, 2);
});

for (const scenario of ['started', 'cancelled']) {
  test(`new bookings reject ${scenario} activities without persisting success`, async () => {
    const { actor, activity } = await fixture();
    if (scenario === 'started') await owner.query("UPDATE activities SET starts_at='2020-01-01' WHERE id=$1", [activity.id]);
    else await owner.query("UPDATE activities SET status='cancelled' WHERE id=$1", [activity.id]);
    const result = await book(activity.id, actor);
    assert.equal(result.status, 409);
    assert.equal(result.error.code, scenario === 'started' ? 'ACTIVITY_STARTED' : 'ACTIVITY_UNAVAILABLE');
    await inspect(activity.id, 0);
  });
}

test('bounded lock contention reports unknown eligibility and the same failed key can retry', async () => {
  const { actor, activity } = await fixture();
  const key = randomUUID();
  const lock = await owner.connect();
  await lock.query('BEGIN');
  await lock.query('SELECT id FROM activities WHERE id=$1 FOR UPDATE', [activity.id]);
  const started = Date.now();
  try {
    const result = await book(activity.id, actor, key);
    assert.equal(result.status, 500);
    assert.equal(result.error.retryable, true);
    assert.ok(Date.now() - started < 3000);
  } finally { await lock.query('ROLLBACK'); lock.release(); }
  const failures = await owner.query("SELECT context FROM analytics_events WHERE actor_id=$1 AND name='booking_failed'", [actor]);
  assert.equal(failures.rows[0].context.eligibility, 'unknown');
  assert.equal(failures.rows[0].context.stage, 'activity_lock');
  assert.equal((await book(activity.id, actor, key)).status, 201);
  await inspect(activity.id, 1);
});

test('pre-commit database failure rolls back every business write but retains attempted and eligible failure events', async () => {
  const { actor, activity } = await fixture();
  const key = randomUUID();
  await owner.query(`CREATE FUNCTION fail_test_outbox() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.activity_id='${activity.id}'::uuid THEN RAISE EXCEPTION 'Injected pre-commit failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER fail_test_outbox BEFORE INSERT ON outbox_events FOR EACH ROW EXECUTE FUNCTION fail_test_outbox()`);
  try {
    assert.equal((await book(activity.id, actor, key)).status, 500);
    await inspect(activity.id, 0);
    assert.equal((await owner.query('SELECT * FROM idempotency_keys WHERE actor_id=$1', [actor])).rowCount, 0);
    const events = await owner.query('SELECT name,context,test,synthetic FROM analytics_events WHERE actor_id=$1', [actor]);
    assert.ok(events.rows.some(event => event.name === 'booking_attempted'));
    assert.ok(events.rows.some(event => event.name === 'booking_failed' && event.context.eligibility === 'eligible'));
    assert.ok(events.rows.every(event => event.test && event.synthetic));
  } finally { await owner.query('DROP TRIGGER fail_test_outbox ON outbox_events; DROP FUNCTION fail_test_outbox()'); }
  assert.equal((await book(activity.id, actor, key)).status, 201);
  await inspect(activity.id, 1);
});

test('post-commit telemetry failure is visible and preserves confirmation', async () => {
  const { actor, activity } = await fixture();
  await owner.query(`CREATE FUNCTION fail_test_telemetry() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.actor_id='${actor}'::uuid AND NEW.name='booking_request_outcome' THEN RAISE EXCEPTION 'Telemetry failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER fail_test_telemetry BEFORE INSERT ON analytics_events FOR EACH ROW EXECUTE FUNCTION fail_test_telemetry()`);
  try {
    const result = await book(activity.id, actor);
    assert.equal(result.status, 201);
    assert.equal(result.data.telemetry, 'degraded');
    assert.equal((await request(`/activities/${activity.id}/booking`, undefined, actor)).data.booking.id, result.data.booking.id);
    await inspect(activity.id, 1);
  } finally { await owner.query('DROP TRIGGER fail_test_telemetry ON analytics_events; DROP FUNCTION fail_test_telemetry()'); }
});

test('invalid requests and raw replays stay distinguishable, runtime cannot mutate bookings', async () => {
  const { actor, activity } = await fixture();
  assert.equal((await request(`/activities/${activity.id}/bookings`, { platform: 'web', journeyId: randomUUID() }, actor)).status, 400);
  assert.equal((await request(`/activities/${activity.id}/bookings`, { platform: 'web', journeyId: randomUUID(), inviterId: actor }, actor, randomUUID())).status, 400);
  await book(activity.id, actor);
  await book(activity.id, actor);
  const outcomes = await owner.query("SELECT context,test FROM analytics_events WHERE name='booking_request_outcome' AND (actor_id=$1 OR context->>'stage'='validation')", [actor]);
  assert.ok(outcomes.rows.some(row => row.context.outcome === 'invalid'));
  assert.ok(outcomes.rows.some(row => row.context.outcome === 'replay'));
  assert.ok(outcomes.rows.every(row => row.test));
  await assert.rejects(runtime.query('UPDATE bookings SET price_minor=0 WHERE activity_id=$1', [activity.id]), /permission denied/);
  await assert.rejects(runtime.query('DELETE FROM bookings WHERE activity_id=$1', [activity.id]), /permission denied/);
});

test('malformed JSON booking requests are counted as invalid raw requests with synthetic markers', async () => {
  const { actor, activity } = await fixture();
  const result = await fetch(`${base}/activities/${activity.id}/bookings`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Demo-Actor-Id': actor, 'Idempotency-Key': randomUUID() }, body: '{' });
  assert.equal(result.status, 400);
  const { requestId } = await result.json();
  const events = await owner.query("SELECT context,test,synthetic FROM analytics_events WHERE context->>'requestId'=$1", [requestId]);
  assert.equal(events.rowCount, 1);
  assert.equal(events.rows[0].context.outcome, 'invalid');
  assert.equal(events.rows[0].test, true);
  assert.equal(events.rows[0].synthetic, true);
});

test('concurrent different keys for a previously unbooked actor establish one immutable membership', async () => {
  const { actor, activity } = await fixture(3);
  const responses = await Promise.all(Array.from({ length: 10 }, () => book(activity.id, actor)));
  assert.equal(responses.filter(result => result.status === 201).length, 1);
  assert.equal(responses.filter(result => result.status === 200).length, 9);
  assert.equal(new Set(responses.map(result => result.data.booking.id)).size, 1);
  await inspect(activity.id, 1);
});

test('started/cancelled seeds are repeatable and propagate synthetic context to organic claim attempts', async () => {
  await owner.query(await readFile(new URL('../seeds/host.sql', import.meta.url), 'utf8'));
  const sql = await readFile(new URL('../seeds/bookings.sql', import.meta.url), 'utf8');
  await owner.query(sql); await owner.query(sql);
  const actor = (await request('/identities', { displayName: 'Organic seeded-activity visitor', journeyId: randomUUID(), platform: 'web', test: true })).data.id;
  for (const [id, code] of [['b3000000-0000-4000-8000-000000000001', 'ACTIVITY_STARTED'], ['b3000000-0000-4000-8000-000000000002', 'ACTIVITY_UNAVAILABLE']]) {
    const result = await book(id!, actor);
    assert.equal(result.error.code, code);
    await inspect(id!, 0);
  }
  const events = await owner.query("SELECT synthetic,test FROM analytics_events WHERE actor_id=$1 AND name IN ('booking_attempted','booking_failed','booking_request_outcome')", [actor]);
  assert.equal(events.rowCount, 6);
  assert.ok(events.rows.every(event => event.synthetic && event.test));
});

test('invalid organic requests inherit trusted activity-host markers and ignore supplied markers', async () => {
  const { activity } = await fixture();
  const actor = (await request('/identities', { displayName: 'Organic invalid requester', journeyId: randomUUID(), platform: 'web' })).data.id;
  for (const body of [{ platform: 'web', journeyId: randomUUID() }, { platform: 'web', journeyId: randomUUID(), synthetic: false, test: false }]) {
    const result = await request(`/activities/${activity.id}/bookings`, body, actor);
    assert.equal(result.status, 400);
    const [event] = (await owner.query("SELECT * FROM analytics_events WHERE context->>'requestId'=$1", [result.requestId])).rows;
    assert.equal(event.synthetic, true);
    assert.equal(event.test, true);
    assert.equal(event.activity_id, activity.id);
    assert.equal(event.context.activityContext, 'resolved');
  }
  const malformed = await fetch(`${base}/activities/${activity.id}/bookings`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Demo-Actor-Id': actor }, body: '{' });
  assert.equal(malformed.status, 400);
  const { requestId } = await malformed.json();
  const [event] = (await owner.query("SELECT * FROM analytics_events WHERE context->>'requestId'=$1", [requestId])).rows;
  assert.equal(event.synthetic, true);
  assert.equal(event.test, true);
});

test('unresolved activity context falls back to trusted actor flags; client markers never classify requests', async () => {
  const labelled = await fixture();
  const organic = (await request('/identities', { displayName: 'Organic fallback fixture', journeyId: randomUUID(), platform: 'web' })).data.id;
  for (const actor of [organic, labelled.actor]) {
    for (const id of ['not-a-uuid', randomUUID()]) {
      const result = await request(`/activities/${id}/bookings`, { platform: 'web', journeyId: randomUUID(), synthetic: true, test: true }, actor, randomUUID());
      assert.equal(result.status, 400);
      assert.equal(result.error.code, 'INVALID_REQUEST');
      const [event] = (await owner.query("SELECT * FROM analytics_events WHERE context->>'requestId'=$1", [result.requestId])).rows;
      assert.equal(event.activity_id, null);
      assert.equal(event.synthetic, actor === labelled.actor);
      assert.equal(event.test, actor === labelled.actor);
      assert.equal(event.context.activityContext, id === 'not-a-uuid' ? 'invalid_id' : 'not_found');
    }
  }
  const result = await book(randomUUID(), labelled.actor);
  assert.equal(result.status, 404);
  const events = (await owner.query("SELECT synthetic,test FROM analytics_events WHERE context->>'requestId'=$1", [result.requestId])).rows;
  assert.ok(events.every(event => event.synthetic && event.test));
  // A trusted test-only host contributes test independently of synthetic.
  await owner.query('UPDATE users SET synthetic=false WHERE id=$1', [labelled.actor]);
  const inherited = await request(`/activities/${labelled.activity.id}/bookings`, {}, organic);
  const [event] = (await owner.query("SELECT synthetic,test FROM analytics_events WHERE context->>'requestId'=$1", [inherited.requestId])).rows;
  assert.equal(event.synthetic, false);
  assert.equal(event.test, true);
});

test('telemetry insertion failure preserves shape, identity and malformed JSON validation responses', async () => {
  const { actor, activity } = await fixture();
  await owner.query(`CREATE FUNCTION fail_invalid_telemetry() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.name='booking_request_outcome' AND NEW.context->>'stage'='validation' THEN RAISE EXCEPTION 'Injected invalid telemetry failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER fail_invalid_telemetry BEFORE INSERT ON analytics_events FOR EACH ROW EXECUTE FUNCTION fail_invalid_telemetry()`);
  try {
    const shape = await request(`/activities/${activity.id}/bookings`, { platform: 'web' }, actor);
    assert.equal(shape.status, 400);
    assert.equal(shape.error.code, 'INVALID_REQUEST');
    assert.equal(shape.error.retryable, false);
    const identity = await request(`/activities/${activity.id}/bookings`, {}, randomUUID());
    assert.equal(identity.status, 401);
    assert.equal(identity.error.code, 'IDENTITY_REQUIRED');
    const malformed = await fetch(`${base}/activities/${activity.id}/bookings`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Demo-Actor-Id': actor }, body: '{' });
    assert.equal(malformed.status, 400);
    assert.equal((await malformed.json()).error.code, 'INVALID_JSON');
  } finally { await owner.query('DROP TRIGGER fail_invalid_telemetry ON analytics_events; DROP FUNCTION fail_invalid_telemetry()'); }
});
