import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { spawn, type ChildProcess } from 'node:child_process';
import net, { type AddressInfo, type Socket } from 'node:net';
import { fileURLToPath } from 'node:url';
import { before, after, test } from 'node:test';
import pg from 'pg';
import { createClient } from 'redis';
import { dispatchOutbox, availabilityChannel } from '../src/outbox.js';
import { WebSocket } from 'ws';
import { runMigrations } from '../src/migrations.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const name = `velio_live_${randomUUID().replaceAll('-', '')}`;
const admin = new pg.Client({ connectionString: process.env.MIGRATION_DATABASE_URL });
const origin = 'http://localhost:5173';
const children: ChildProcess[] = [];
const apiChildren = new Map<string, ChildProcess>();
const clients: WebSocket[] = [];
const pipes = new Set<Socket>();
let paused = false;
let proxy: net.Server;
let owner: pg.Pool;
let runtime: pg.Pool;
let base: string;
let remote: string;
let redisUrl: string;
const logs: string[] = [];
async function until(check: () => boolean | Promise<boolean>, timeout = 8000) {
  const end = Date.now() + timeout;
  while (!await check()) {
    assert.ok(Date.now() < end, 'Timed out waiting for observable live behavior');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
function databaseUrl(value: string) { const url = new URL(value); url.pathname = `/${name}`; return url.href; }
async function startApi(reusePort?: number) {
  const reservation = net.createServer();
  reservation.listen(reusePort ?? 0, '127.0.0.1'); await once(reservation, 'listening');
  const port = (reservation.address() as AddressInfo).port;
  await new Promise<void>(resolve => reservation.close(() => resolve()));
  const child = spawn(process.execPath, ['--import', 'tsx', 'backend/src/server.ts'], { cwd: root,
    env: { ...process.env, DATABASE_URL: databaseUrl(process.env.DATABASE_URL!), REDIS_URL: redisUrl, PORT: String(port), HOST: '127.0.0.1', WEB_ORIGIN: origin },
    stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  let started = false;
  child.stdout!.on('data', data => { if (String(data).includes('Velio API listening')) started = true; });
  child.stderr!.on('data', data => { logs.push(String(data)); });
  await until(() => started || child.exitCode !== null);
  assert.equal(child.exitCode, null, 'API process must remain running');
  const api = `http://127.0.0.1:${port}/api`;
  apiChildren.set(api, child);
  return api;
}
before(async () => {
  assert.ok(process.env.MIGRATION_DATABASE_URL && process.env.DATABASE_URL && process.env.REDIS_URL, 'Set up local dependencies first');
  await admin.connect(); await admin.query(`CREATE DATABASE ${name}`);
  const migrationUrl = databaseUrl(process.env.MIGRATION_DATABASE_URL!);
  await runMigrations(new pg.Client({ connectionString: migrationUrl }), fileURLToPath(new URL('../migrations/', import.meta.url)));
  owner = new pg.Pool({ connectionString: migrationUrl });
  runtime = new pg.Pool({ connectionString: databaseUrl(process.env.DATABASE_URL!) });
  const upstream = new URL(process.env.REDIS_URL!);
  const upstreamPort = Number(upstream.port || 6379);
  const upstreamHost = upstream.hostname;
  proxy = net.createServer(incoming => {
    if (paused) { incoming.destroy(); return; }
    const outgoing = net.connect(upstreamPort, upstreamHost);
    for (const socket of [incoming, outgoing]) {
      pipes.add(socket); socket.on('error', () => {}); socket.on('close', () => { pipes.delete(socket); incoming.destroy(); outgoing.destroy(); });
    }
    incoming.pipe(outgoing); outgoing.pipe(incoming);
  });
  proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening');
  upstream.hostname = '127.0.0.1'; upstream.port = String((proxy.address() as AddressInfo).port); redisUrl = upstream.href;
  base = await startApi(); remote = await startApi();
  await until(async () => (await fetch(`${base}/ready`)).ok && (await fetch(`${remote}/ready`)).ok);
});
after(async () => {
  for (const socket of clients) socket.terminate();
  for (const child of children) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    child.kill('SIGTERM');
    await once(child, 'exit');
  }
  for (const socket of pipes) socket.destroy();
  if (proxy) await new Promise<void>(resolve => proxy.close(() => resolve()));
  await runtime?.end(); await owner?.end();
  await admin.query(`DROP DATABASE IF EXISTS ${name}`);
  await admin.end();
});
async function request(path: string, body?: unknown, actorId?: string) {
  const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json',
    ...(actorId ? { 'X-Demo-Actor-Id': actorId, 'Idempotency-Key': randomUUID() } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, ...await response.json() };
}
async function actor() {
  return (await request('/identities', { displayName: 'Live synthetic booker', journeyId: randomUUID(), platform: 'web', synthetic: true, test: true })).data.id as string;
}
async function fixture(capacity = 3) {
  const actorId = await actor();
  const activity = (await request('/activities', { title: 'Live synthetic walk', description: 'Isolated live scenario', meetingLocation: 'Marina',
    startsAt: '2030-01-15T07:00:00Z', timezone: 'Africa/Lagos', capacity, priceMinor: 0, currency: 'NGN' }, actorId)).data;
  return { actorId, activity };
}
function book(activityId: string, actorId: string) { return request(`/activities/${activityId}/bookings`, { platform: 'web', journeyId: randomUUID() }, actorId); }
interface Snapshot { type: string; activityId: string; eventId: string | null; version: number; confirmedCount: number; remainingSeats: number; activity: { participants: unknown[]; inviteState?: string } }
async function connect(activityId: string, api = base, foreground = true, clientId: string = randomUUID(), waitSnapshot = true, context: Record<string, unknown> = {}) {
  const socket = new WebSocket(api.replace('http:', 'ws:').replace('/api', '/api/live'), { origin });
  clients.push(socket);
  const messages: Snapshot[] = [];
  socket.on('message', value => messages.push(JSON.parse(value.toString())));
  socket.on('error', () => {});
  await once(socket, 'open');
  socket.send(JSON.stringify({ type: 'subscribe', activityId, clientId, foreground, ...context }));
  if (waitSnapshot) await until(() => messages.some(m => m.type === 'snapshot'));
  return { socket, messages, clientId };
}
function ack(socket: WebSocket, snapshot: Snapshot) {
  socket.send(JSON.stringify({ type: 'ack', eventId: snapshot.eventId, activityId: snapshot.activityId, version: snapshot.version }));
}
async function groups() { return (await request('/metrics/live?includeTest=true')).data.groups as Array<Record<string, any>>; }

test('two API processes deliver committed membership; a missing foreground ACK remains a delivery miss', async () => {
  const { actorId, activity } = await fixture(1);
  const local = await connect(activity.id);
  const missing = await connect(activity.id);
  const hidden = await connect(activity.id, base, false);
  const other = await connect(activity.id, remote);
  const result = await book(activity.id, actorId);
  assert.equal(result.status, 201);
  await until(() => [local, missing, other].every(client => client.messages.some(m => m.eventId && m.version === 2)));
  for (const client of [local, other]) {
    const update = client.messages.find(m => m.eventId && m.version === 2)!;
    assert.equal(update.confirmedCount, 1); assert.equal(update.remainingSeats, 0);
    assert.equal(update.activity.participants.length, 1); ack(client.socket, update);
  }
  await until(async () => (await groups()).find(g => g.timing === 'commit_observed')?.acknowledged === 1);
  await new Promise(resolve => setTimeout(resolve, 2100));
  const measured = await groups();
  const exact = measured.find(g => g.timing === 'commit_observed')!;
  const proxyGroup = measured.find(g => g.timing === 'pre_commit_proxy')!;
  assert.equal(exact.expectedDeliveries, 2); assert.equal(exact.acknowledged, 1);
  assert.equal(exact.deliveryMisses, 1); assert.equal(exact.eventualAckCoverage, .5); assert.equal(exact.everyClientTargetMet, false);
  assert.ok(exact.ackOnlyPerBookingP95Ms >= 0 && exact.ackOnlyPerBookingP95Ms < 2000);
  assert.equal(exact.bookingsWithSubscribers, 1); assert.equal(exact.clients.find((c: { acknowledged: number }) => c.acknowledged > 0).ackOnlySamples, 1);
  assert.equal(proxyGroup.expectedDeliveries, 1); assert.equal(proxyGroup.acknowledged, 1);
  assert.equal(hidden.messages.some(m => m.eventId), false);
  const excluded = (await request('/metrics/live')).data.groups;
  assert.ok(excluded.every((g: Record<string, unknown>) => g.expectedDeliveries === 0 && g.eventualAckCoverage === null && g.everyClientTargetMet === null));
  const reconciliation = (await owner.query('SELECT * FROM booking_reconciliation WHERE activity_id=$1', [activity.id])).rows[0];
  assert.equal(reconciliation.counter_mismatch, false); assert.equal(reconciliation.oversold, false);
  console.log('LIVE_MEASUREMENT', JSON.stringify({ exact, proxy: proxyGroup }));
  for (const c of [local, missing, hidden, other]) c.socket.terminate();
});

test('Redis interruption preserves committed booking and durable retries; periodic reconciliation recovers remote delivery', async () => {
  const { actorId, activity } = await fixture(1);
  const remoteClient = await connect(activity.id, remote);
  paused = true;
  for (const socket of pipes) socket.destroy();
  await until(async () => (await fetch(`${base}/ready`)).status === 503);
  const result = await book(activity.id, actorId);
  assert.equal(result.status, 201); assert.equal(result.data.telemetry, 'ok');
  const disconnectedPublisher = createClient({ url: process.env.REDIS_URL, disableOfflineQueue: true });
  const failures: unknown[] = [];
  await dispatchOutbox(runtime, message => disconnectedPublisher.publish(availabilityChannel, message), (_context, error) => failures.push(error));
  const failed = (await owner.query('SELECT id,attempts,dispatched_at,retry_at > clock_timestamp() AS waiting FROM outbox_events WHERE activity_id=$1', [activity.id])).rows[0];
  assert.equal(failed.attempts, 1); assert.equal(failed.dispatched_at, null); assert.equal(failed.waiting, true);
  assert.equal(failures.length, 1);
  await until(() => remoteClient.messages.some(m => m.eventId === failed.id && m.remainingSeats === 0));
  ack(remoteClient.socket, remoteClient.messages.find(m => m.eventId === failed.id)!);
  await until(async () => (await owner.query('SELECT ack_at FROM live_deliveries WHERE event_id=$1', [failed.id])).rows.some(r => r.ack_at));
  const observation = (await owner.query('SELECT timing FROM live_observations WHERE event_id=$1 AND expected > 0', [failed.id])).rows;
  assert.ok(observation.every(o => o.timing === 'pre_commit_proxy'));
  const publisher = createClient({ url: process.env.REDIS_URL, disableOfflineQueue: true });
  publisher.on('error', () => {});
  await publisher.connect();
  try {
    await until(async () => (await owner.query('SELECT retry_at <= clock_timestamp() AS due FROM outbox_events WHERE id=$1', [failed.id])).rows[0].due);
    await dispatchOutbox(runtime, message => publisher.publish(availabilityChannel, message));
  } finally { publisher.destroy(); paused = false; }
  await until(async () => (await fetch(`${base}/ready`)).ok && (await fetch(`${remote}/ready`)).ok);
  const recovered = (await owner.query('SELECT attempts,dispatched_at FROM outbox_events WHERE id=$1', [failed.id])).rows[0];
  assert.equal(recovered.attempts, 2); assert.ok(recovered.dispatched_at);
  const detail = (await request(`/activities/${activity.id}`)).data;
  assert.equal(detail.confirmedCount, 1); assert.equal(detail.participants.length, 1); assert.equal(detail.version, 2);
  assert.equal((await request(`/activities/${activity.id}/booking`, undefined, actorId)).data.booking.id, result.data.booking.id);
  remoteClient.socket.terminate();
});

test('slow delivery instrumentation counts a late ACK immediately rather than extending the target deadline', async () => {
  const { actorId, activity } = await fixture(1);
  const client = await connect(activity.id);
  const baseline = (await groups()).find(g => g.timing === 'commit_observed')!;
  // Fault injection at the real storage boundary, scoped to this test activity.
  await owner.query(`CREATE FUNCTION delay_live_observation() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF EXISTS (SELECT 1 FROM outbox_events WHERE id=NEW.event_id AND activity_id='${activity.id}'::uuid)
        THEN PERFORM pg_sleep(1.1); END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER delay_live BEFORE INSERT ON live_observations FOR EACH ROW EXECUTE FUNCTION delay_live_observation()`);
  try {
    assert.equal((await book(activity.id, actorId)).status, 201);
    await until(() => client.messages.some(m => m.eventId && m.version === 2));
    const delivered = client.messages.find(m => m.eventId && m.version === 2)!;
    await new Promise(resolve => setTimeout(resolve, 1200));
    ack(client.socket, delivered);
    await until(async () => (await groups()).find(g => g.timing === 'commit_observed')!.acknowledged === baseline.acknowledged + 1);
    const exact = (await groups()).find(g => g.timing === 'commit_observed')!;
    assert.equal(exact.deliveryMisses, baseline.deliveryMisses + 1);
    assert.ok(exact.perBookingMaxima.find((m: { eventId: string }) => m.eventId === delivered.eventId).ackOnlyMaximumMs >= 2200);
    const clock = (await owner.query(`SELECT o.timing,d.delay_ms FROM live_observations o JOIN live_deliveries d USING(event_id,process_id)
      WHERE o.event_id=$1 AND o.expected=1`,[delivered.eventId])).rows[0];
    assert.equal(clock.timing,'commit_observed');
    assert.ok(clock.delay_ms >= 2200, 'Concurrent Redis publication cannot overwrite the exact clock while its write is delayed');
  } finally {
    await owner.query('DROP TRIGGER delay_live ON live_observations; DROP FUNCTION delay_live_observation()');
    client.socket.terminate();
  }
});

test('subscriptions racing committed bookings converge on the current version and ignore duplicate publications', async () => {
  const { activity } = await fixture(4);
  const actors = await Promise.all(Array.from({ length: 4 }, actor));
  const subscribers = await Promise.all(Array.from({ length: 12 }, () => connect(activity.id, base, true, randomUUID(), false)));
  const bookings = await Promise.all(actors.map(actorId => book(activity.id, actorId)));
  assert.ok(bookings.every(b => b.status === 201));
  await until(() => subscribers.every(s => s.messages.some(m => m.type === 'snapshot' && m.version === 5 && m.activity.participants.length === 4)));
  const events = (await owner.query('SELECT payload,booking_id AS "bookingId",created_at AS "createdAt" FROM outbox_events WHERE activity_id=$1 ORDER BY version DESC', [activity.id])).rows;
  const publisher = createClient({ url: process.env.REDIS_URL }); publisher.on('error', () => {}); await publisher.connect();
  try {
    // Reorder and duplicate real Redis messages after the latest snapshot.
    for (const e of [...events, ...events]) await publisher.publish(availabilityChannel, JSON.stringify({ ...e.payload, bookingId: e.bookingId, createdAt: e.createdAt.toISOString() }));
    for (const sub of subscribers) for (const update of sub.messages.filter(m => m.eventId)) ack(sub.socket, update);
    await new Promise(resolve => setTimeout(resolve, 1100));
    const expected = (await owner.query('SELECT expected FROM live_observations o JOIN outbox_events e ON e.id=o.event_id WHERE e.activity_id=$1 AND timing=\'commit_observed\'', [activity.id])).rows;
    assert.equal(expected.length, 4); assert.ok(expected.every(o => o.expected === 12));
    for (const sub of subscribers) {
      assert.equal(sub.messages.at(-1)!.version, 5);
      assert.equal(sub.messages.at(-1)!.confirmedCount, 4);
      assert.equal(sub.messages.at(-1)!.activity.participants.length, 4);
    }
    const integrity = (await owner.query('SELECT * FROM booking_reconciliation WHERE activity_id=$1', [activity.id])).rows[0];
    assert.equal(integrity.counter_mismatch, false); assert.equal(integrity.oversold, false);
  } finally { publisher.destroy(); for (const sub of subscribers) sub.socket.terminate(); }
});

test('API restart restores a committed snapshot without erasing the previous connection delivery miss', async () => {
  const { actorId, activity } = await fixture(1);
  const client = await connect(activity.id);
  const booked = await book(activity.id, actorId);
  assert.equal(booked.status, 201);
  await until(() => client.messages.some(m => m.eventId && m.version === 2));
  const eventId = client.messages.find(m => m.eventId)!.eventId;
  const port = Number(new URL(base).port);
  const child = apiChildren.get(base)!;
  child.kill('SIGTERM'); await once(child, 'exit');
  base = await startApi(port);
  const restored = await connect(activity.id, base, true, client.clientId);
  assert.equal(restored.messages[0]!.version, 2); assert.equal(restored.messages[0]!.activity.participants.length, 1);
  assert.equal((await request(`/activities/${activity.id}/booking`, undefined, actorId)).data.booking.id, booked.data.booking.id);
  await new Promise(resolve => setTimeout(resolve, 2100));
  const missed = (await owner.query('SELECT ack_at,deadline < clock_timestamp() AS expired FROM live_deliveries WHERE event_id=$1', [eventId])).rows;
  assert.equal(missed.length, 1); assert.equal(missed[0].ack_at, null); assert.equal(missed[0].expired, true);
  assert.equal((await groups()).find(g => g.timing === 'commit_observed')!.everyClientTargetMet, false);
  restored.socket.terminate();
});

test('50 overlapping bookings measure local commit-observed latency with complete subscriber coverage', async () => {
  const { activity } = await fixture(50);
  const actors = await Promise.all(Array.from({ length: 50 }, actor));
  const client = await connect(activity.id);
  client.socket.on('message', data => { const update = JSON.parse(String(data)) as Snapshot; if (update.eventId) ack(client.socket, update); });
  const results = await Promise.all(actors.map(actorId => book(activity.id, actorId)));
  assert.ok(results.every(r => r.status === 201));
  await until(async () => (await owner.query(`SELECT count(*)::int AS n FROM live_deliveries d JOIN outbox_events e ON e.id=d.event_id
    WHERE e.activity_id=$1 AND d.ack_at IS NOT NULL`, [activity.id])).rows[0].n === 50);
  const eventIds = new Set((await owner.query('SELECT id FROM outbox_events WHERE activity_id=$1', [activity.id])).rows.map(e => e.id));
  const exact = (await groups()).find(g => g.timing === 'commit_observed')!;
  const maxima = exact.perBookingMaxima.filter((m: { eventId: string }) => eventIds.has(m.eventId));
  const records = (await owner.query(`SELECT count(*)::int AS expected,count(ack_at)::int AS acknowledged,
    count(*) FILTER (WHERE ack_at IS NULL OR delay_ms > 2000)::int AS misses,
    percentile_disc(.95) WITHIN GROUP (ORDER BY delay_ms) AS p95, max(delay_ms) AS maximum
    FROM live_deliveries d JOIN outbox_events e ON e.id=d.event_id WHERE e.activity_id=$1`, [activity.id])).rows[0];
  assert.equal(maxima.length, 50); assert.equal(records.expected, 50); assert.equal(records.acknowledged, 50);
  assert.equal(exact.clients.find((c: { clientId: string }) => c.clientId === client.clientId).ackOnlyP95Ms, records.p95);
  // Host load can change attainment; preserve/report misses instead of making wall-clock speed a functional assertion.
  const state = (await request(`/activities/${activity.id}`)).data;
  assert.equal(state.confirmedCount, 50); assert.equal(state.participants.length, 50); assert.equal(state.version, 51);
  console.log('LIVE_50_BOOKING_MEASUREMENT', JSON.stringify({ ...records, coverage: 1, timing: 'commit_observed', apiProcesses: 2 }));
  client.socket.terminate();
});

test('a remote subscriber joining during a locked booking is included in recovery coverage', async () => {
  const { actorId, activity } = await fixture(1);
  const lock = await owner.connect();
  await lock.query('BEGIN'); await lock.query('SELECT id FROM activities WHERE id=$1 FOR UPDATE', [activity.id]);
  const booking = book(activity.id, actorId);
  let client: Awaited<ReturnType<typeof connect>> | undefined;
  try {
    await until(async () => (await owner.query(`SELECT 1 FROM pg_stat_activity WHERE datname=$1 AND wait_event_type='Lock'
      AND query LIKE '%FROM activities WHERE id=$1 FOR UPDATE%'`, [name])).rows.length > 0);
    client = await connect(activity.id, remote);
    assert.equal(client.messages[0]!.version, 1);
    await lock.query('COMMIT');
    assert.equal((await booking).status, 201);
    await until(() => client!.messages.some(m => m.eventId && m.version === 2));
    const update = client.messages.find(m => m.eventId && m.version === 2)!;
    ack(client.socket, update);
    await until(async () => (await owner.query(`SELECT d.ack_at FROM live_deliveries d JOIN outbox_events e ON e.id=d.event_id
      WHERE e.activity_id=$1`, [activity.id])).rows.some(r => r.ack_at));
  } finally { await lock.query('ROLLBACK'); lock.release(); client?.socket.terminate(); }
});

test('an observation storage failure is visible from another API and retried with its original cohort', async () => {
  const { actorId, activity } = await fixture(1);
  const client = await connect(activity.id);
  await owner.query(`CREATE FUNCTION fail_live_observation() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.timing='commit_observed' AND EXISTS (SELECT 1 FROM outbox_events WHERE id=NEW.event_id AND activity_id='${activity.id}'::uuid)
        THEN RAISE EXCEPTION 'Scoped observation storage failure'; END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER fail_live BEFORE INSERT ON live_observations FOR EACH ROW EXECUTE FUNCTION fail_live_observation()`);
  try {
    assert.equal((await book(activity.id, actorId)).status, 201);
    const remoteMetrics = await (await fetch(remote + '/metrics/live?includeTest=true')).json();
    assert.ok(remoteMetrics.data.instrumentationGaps > 0, 'Another process must see missing origin observations');
    assert.ok(remoteMetrics.data.groups.every((g: { everyClientTargetMet: boolean | null }) => g.everyClientTargetMet !== true));
  } finally { await owner.query('DROP TRIGGER fail_live ON live_observations; DROP FUNCTION fail_live_observation()'); }
  await until(() => client.messages.some(m => m.eventId && m.version === 2));
  const eventId = client.messages.find(m => m.eventId)!.eventId;
  ack(client.socket, client.messages.find(m => m.eventId)!);
  await until(async () => (await owner.query(`SELECT d.ack_at,o.timing,o.expected FROM live_deliveries d
    JOIN live_observations o USING (event_id,process_id) WHERE d.event_id=$1`, [eventId])).rows.some(r => r.ack_at && r.timing === 'commit_observed' && r.expected === 1));
  client.socket.terminate();
});

test('expired non-ACK deliveries stop repeated event snapshots but a late ACK remains measurable from durable state', async () => {
  const { actorId, activity } = await fixture(1);
  const client = await connect(activity.id);
  assert.equal((await book(activity.id, actorId)).status, 201);
  await until(() => client.messages.some(m => m.eventId && m.version === 2));
  const update = client.messages.find(m => m.eventId)!;
  await new Promise(resolve => setTimeout(resolve, 3100));
  const previous = client.messages.length;
  await new Promise(resolve => setTimeout(resolve, 1100));
  const reconciled = client.messages.slice(previous);
  assert.ok(reconciled.length > 0); assert.ok(reconciled.every(m => m.type === 'snapshot' && m.eventId === null && m.version === 2));
  ack(client.socket, update);
  await until(async () => (await owner.query('SELECT ack_at,delay_ms FROM live_deliveries WHERE event_id=$1', [update.eventId])).rows.some(r => r.ack_at && r.delay_ms > 4000));
  client.socket.terminate();
});

test('a failed origin observation cannot become a successful coverage verdict after its API restarts', async () => {
  const { actorId, activity } = await fixture(1);
  const client = await connect(activity.id);
  await owner.query(`CREATE FUNCTION fail_origin_before_restart() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.timing='commit_observed' AND EXISTS (SELECT 1 FROM outbox_events WHERE id=NEW.event_id AND activity_id='${activity.id}'::uuid)
        THEN RAISE EXCEPTION 'Scoped origin failure before restart'; END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER fail_origin BEFORE INSERT ON live_observations FOR EACH ROW EXECUTE FUNCTION fail_origin_before_restart()`);
  try {
    assert.equal((await book(activity.id, actorId)).status, 201);
    const port = Number(new URL(base).port);
    const child = apiChildren.get(base)!;
    child.kill('SIGTERM'); await once(child, 'exit');
    base = await startApi(port);
    for (const api of [base, remote]) {
      const metrics = (await (await fetch(api + '/metrics/live?includeTest=true')).json()).data;
      assert.ok(metrics.instrumentationGaps > 0);
      assert.ok(metrics.groups.every((g: { everyClientTargetMet: boolean | null }) => g.everyClientTargetMet !== true));
    }
  } finally {
    await owner.query('DROP TRIGGER fail_origin ON live_observations; DROP FUNCTION fail_origin_before_restart()');
    client.socket.terminate();
  }
});

test('an abrupt gateway crash stays conservative until its verified lifetime is reconciled', async () => {
  const oldProcessId = (await request('/metrics/live?includeTest=true')).data.instrumentation.processId;
  const baseline = (await request('/metrics/live?includeTest=true')).data.instrumentationGaps;
  const child = apiChildren.get(base)!;
  const port = Number(new URL(base).port);
  child.kill('SIGKILL'); await once(child, 'exit');
  const verifiedTerminationBound = new Date().toISOString();
  const unclosed = (await owner.query('SELECT stopped_at FROM live_processes WHERE process_id=$1', [oldProcessId])).rows[0];
  assert.equal(unclosed.stopped_at, null);
  base = await startApi(port);
  // Explicit operator recovery closes only the proven-dead gateway, retaining all historical evidence.
  await owner.query('UPDATE live_processes SET stopped_at=$2 WHERE process_id=$1 AND stopped_at IS NULL', [oldProcessId, verifiedTerminationBound]);
  const { actorId, activity } = await fixture(1);
  const client = await connect(activity.id);
  assert.equal((await book(activity.id, actorId)).status, 201);
  await until(() => client.messages.some(m => m.eventId && m.version === 2));
  ack(client.socket, client.messages.find(m => m.eventId)!);
  await until(async () => (await request('/metrics/live?includeTest=true')).data.instrumentationGaps === baseline);
  assert.equal((await owner.query('SELECT stopped_at FROM live_processes WHERE process_id=$1', [oldProcessId])).rows[0].stopped_at.toISOString(), verifiedTerminationBound);
  client.socket.terminate();
});

test('fully missed bookings and clients remain visible; a finalized miss dominates pending observations', async () => {
  const { actorId, activity } = await fixture(1);
  const client = await connect(activity.id);
  await book(activity.id, actorId);
  await until(() => client.messages.some(m => m.eventId));
  const eventId = client.messages.find(m => m.eventId)!.eventId;
  // Hiding after capture must preserve the original denominator.
  client.socket.send(JSON.stringify({ type: 'foreground', foreground: false }));
  await new Promise(resolve => setTimeout(resolve, 2100));
  const other = await fixture(1);
  const pendingClient = await connect(other.activity.id);
  await book(other.activity.id, other.actorId);
  await until(() => pendingClient.messages.some(m => m.eventId));
  const exact = (await groups()).find(g => g.timing === 'commit_observed')!;
  assert.ok(exact.pending > 0); assert.ok(exact.deliveryMisses > 0); assert.equal(exact.everyClientTargetMet, false);
  const missedBooking = exact.perBookingMaxima.find((value: { eventId: string }) => value.eventId === eventId);
  assert.equal(missedBooking.expected, 1); assert.equal(missedBooking.ackOnlyMaximumMs, null); assert.equal(missedBooking.latencyStatus, 'no_data');
  const missedClient = exact.clients.find((value: { clientId: string }) => value.clientId === client.clientId);
  assert.equal(missedClient.expected, 1); assert.equal(missedClient.ackOnlyP95Ms, null); assert.equal(missedClient.deliveryMisses, 1);
  ack(client.socket, client.messages.find(m => m.eventId)!);
  await until(async () => (await owner.query('SELECT ack_at FROM live_deliveries WHERE event_id=$1', [eventId])).rows.some(row => row.ack_at));
  const late = (await groups()).find(g => g.timing === 'commit_observed')!;
  assert.ok(late.eventualAckCoverage > late.onTimeCoverage);
  client.socket.terminate(); pendingClient.socket.terminate();
});

test('telemetry failure sends current availability and keeps coverage failure visible', async () => {
  const { actorId, activity } = await fixture(1);
  const client = await connect(activity.id);
  await owner.query(`CREATE FUNCTION fail_telemetry_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF EXISTS (SELECT 1 FROM outbox_events WHERE id=NEW.event_id AND activity_id='${activity.id}'::uuid)
      THEN RAISE EXCEPTION 'Scoped telemetry failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER fail_telemetry BEFORE INSERT ON live_observations FOR EACH ROW EXECUTE FUNCTION fail_telemetry_snapshot()`);
  try {
    await book(activity.id, actorId);
    await until(() => client.messages.some(m => m.type === 'snapshot' && m.version === 2 && !m.eventId));
    assert.equal(client.messages.some(m => m.type === 'unavailable'), false);
    const metrics = (await request('/metrics/live?includeTest=true')).data;
    assert.ok(metrics.instrumentationGaps > 0); assert.ok(metrics.instrumentation.measurementFailures > 0);
  } finally { await owner.query('DROP TRIGGER fail_telemetry ON live_observations; DROP FUNCTION fail_telemetry_snapshot()'); }
  await until(() => client.messages.some(m => m.eventId && m.version === 2));
  client.socket.terminate();
});

test('expired proxy measurement still sends a current snapshot and normalizes ACK identifiers', async () => {
  const { actorId, activity } = await fixture(1);
  const lock = await owner.connect();
  await lock.query('BEGIN'); await lock.query('SELECT id FROM activities WHERE id=$1 FOR UPDATE', [activity.id]);
  const booking = book(activity.id, actorId);
  await until(async () => (await owner.query(`SELECT 1 FROM pg_stat_activity WHERE datname=$1 AND wait_event_type='Lock' AND query LIKE '%FROM activities WHERE id=$1 FOR UPDATE%'`, [name])).rows.length > 0);
  const client = await connect(activity.id.toUpperCase(), remote, true, randomUUID().toUpperCase());
  await owner.query(`CREATE FUNCTION expire_proxy_write() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.timing='pre_commit_proxy' AND EXISTS (SELECT 1 FROM outbox_events WHERE id=NEW.event_id AND activity_id='${activity.id}'::uuid)
      THEN PERFORM pg_sleep(1.1); END IF; RETURN NEW; END $$;
    CREATE TRIGGER expire_proxy BEFORE INSERT ON live_observations FOR EACH ROW EXECUTE FUNCTION expire_proxy_write()`);
  try {
    await new Promise(resolve => setTimeout(resolve, 1100));
    await lock.query('COMMIT'); assert.equal((await booking).status,201);
    await until(() => client.messages.some(m => m.type === 'snapshot' && m.version === 2));
    // Even an already expired measurement can be delivered and later ACKed.
    const update = client.messages.find(m => m.eventId && m.version === 2);
    assert.ok(update);
    client.socket.send(JSON.stringify({ type: 'ack', eventId: update.eventId!.toUpperCase(), activityId: activity.id.toUpperCase(), version: update.version }));
    await until(async () => (await owner.query(`SELECT d.ack_at,d.delay_ms,o.timing FROM live_deliveries d JOIN live_observations o USING(event_id,process_id) WHERE d.event_id=$1`, [update.eventId])).rows.some(row => row.ack_at && row.delay_ms > 2000 && row.timing === 'pre_commit_proxy'));
  } finally { await lock.query('ROLLBACK'); lock.release(); client.socket.terminate(); await owner.query('DROP TRIGGER expire_proxy ON live_observations; DROP FUNCTION expire_proxy_write()'); }
});

test('graceful shutdown drains in-flight bookings and observation writes through one cutoff under traffic', async () => {
  const { actorId, activity } = await fixture(1);
  const during = await fixture(1);
  const processId = (await request('/metrics/live?includeTest=true')).data.instrumentation.processId;
  const lock = await owner.connect();
  await lock.query('BEGIN'); await lock.query('SELECT id FROM activities WHERE id=$1 FOR UPDATE', [activity.id]);
  const booking = book(activity.id, actorId);
  await until(async () => (await owner.query(`SELECT 1 FROM pg_stat_activity WHERE datname=$1 AND wait_event_type='Lock' AND query LIKE '%FROM activities WHERE id=$1 FOR UPDATE%'`, [name])).rows.length > 0);
  await owner.query(`CREATE FUNCTION shutdown_observation_delay() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.process_id='${processId}'::uuid THEN PERFORM pg_sleep(.25); END IF; RETURN NEW; END $$;
    CREATE TRIGGER shutdown_delay BEFORE INSERT ON live_observations FOR EACH ROW EXECUTE FUNCTION shutdown_observation_delay()`);
  const child = apiChildren.get(base)!;
  const port = Number(new URL(base).port);
  const exit = once(child, 'exit');
  child.kill('SIGTERM');
  try {
    const remoteResponse = await fetch(`${remote}/activities/${during.activity.id}/bookings`, { method: 'POST', headers: { 'Content-Type':'application/json','X-Demo-Actor-Id':during.actorId,'Idempotency-Key':randomUUID() }, body: JSON.stringify({platform:'web',journeyId:randomUUID()}) });
    assert.equal(remoteResponse.status, 201);
    await lock.query('COMMIT'); assert.equal((await booking).status, 201);
    const [code] = await exit; assert.equal(code, 0);
    const lifetime = (await owner.query('SELECT stopped_at FROM live_processes WHERE process_id=$1',[processId])).rows[0];
    assert.ok(lifetime.stopped_at);
    const observations = (await owner.query(`SELECT o.timing,e.activity_id FROM live_observations o JOIN outbox_events e ON e.id=o.event_id WHERE o.process_id=$1 AND e.activity_id=ANY($2::uuid[])`,[processId,[activity.id,during.activity.id]])).rows;
    assert.equal(observations.length,2); assert.ok(observations.some(row=>row.activity_id===activity.id && row.timing==='commit_observed'));
    base = await startApi(port);
    const after = await fixture(1); await book(after.activity.id,after.actorId);
    await until(async () => (await owner.query(`SELECT count(*)::int AS n FROM live_observations o JOIN outbox_events e ON e.id=o.event_id WHERE e.activity_id=$1`,[after.activity.id])).rows[0].n===2);
    assert.equal((await owner.query(`SELECT 1 FROM live_observations o JOIN outbox_events e ON e.id=o.event_id WHERE o.process_id=$1 AND e.activity_id=$2`,[processId,after.activity.id])).rowCount,0);
  } finally { await lock.query('ROLLBACK'); lock.release(); await owner.query('DROP TRIGGER shutdown_delay ON live_observations; DROP FUNCTION shutdown_observation_delay()'); }
});

test('bounded reconciliation pages advance past unresolved writes and revisit them without dropping coverage', async () => {
  const { activity } = await fixture(105);
  const actors = await Promise.all(Array.from({length:105},actor));
  const timestamp=(await owner.query("SELECT (date_trunc('milliseconds',clock_timestamp())+interval '321 microseconds')::text AS value")).rows[0].value;
  await owner.query(`CREATE FUNCTION same_microsecond_page() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.activity_id='${activity.id}'::uuid THEN NEW.created_at='${timestamp}'::timestamptz; END IF; RETURN NEW; END $$;
    CREATE TRIGGER same_page BEFORE INSERT ON outbox_events FOR EACH ROW EXECUTE FUNCTION same_microsecond_page()`);
  paused=true; for (const pipe of pipes) pipe.destroy();
  await owner.query(`CREATE FUNCTION fail_first_proxy_page() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.timing='pre_commit_proxy' AND EXISTS (SELECT 1 FROM outbox_events WHERE id=NEW.event_id AND activity_id='${activity.id}'::uuid AND version=2)
      THEN RAISE EXCEPTION 'Scoped first-page write failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER fail_page BEFORE INSERT ON live_observations FOR EACH ROW EXECUTE FUNCTION fail_first_proxy_page()`);
  try {
    for (let offset=0;offset<actors.length;offset+=25) {
      const results=await Promise.all(actors.slice(offset,offset+25).map(id=>book(activity.id,id)));
      assert.ok(results.every(result=>result.status===201));
    }
    await until(async () => (await owner.query(`SELECT count(*)::int AS n FROM live_observations o JOIN outbox_events e ON e.id=o.event_id
      WHERE e.activity_id=$1 AND o.timing='pre_commit_proxy'`,[activity.id])).rows[0].n===104,15_000);
  } finally { await owner.query('DROP TRIGGER fail_page ON live_observations; DROP FUNCTION fail_first_proxy_page(); DROP TRIGGER same_page ON outbox_events; DROP FUNCTION same_microsecond_page()'); paused=false; }
  await until(async () => (await owner.query(`SELECT count(*)::int AS n FROM live_observations o JOIN outbox_events e ON e.id=o.event_id
    WHERE e.activity_id=$1 AND o.timing='pre_commit_proxy'`,[activity.id])).rows[0].n===105,15_000);
  const child=apiChildren.get(remote)!; const port=Number(new URL(remote).port); const exit=once(child,'exit');
  child.kill('SIGTERM'); const [code]=await exit; assert.equal(code,0,'Same-microsecond pages must drain without forced shutdown');
  remote=await startApi(port);
  const metrics=(await request('/metrics/live?includeTest=true')).data;
  assert.equal(metrics.reporting.truncated,false);
  assert.equal(metrics.window.maxDays,7);
  assert.ok(metrics.groups.every((group:{clients:unknown[];perBookingMaxima:unknown[]})=>group.clients.length<=100 && group.perBookingMaxima.length<=100));
  assert.equal((await request('/metrics/live?includeTest=1')).status,400);
  assert.equal((await request('/metrics/live?from=2026-01-01T00:00:00Z&to=2026-02-01T00:00:00Z')).status,400);
});

test('ACK storage failure preserves its arrival clock and does not interrupt current availability', async () => {
  const { actorId, activity } = await fixture(2);
  const nextActor=await actor();
  const client=await connect(activity.id);
  await owner.query(`CREATE FUNCTION fail_ack_write() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.ack_at IS NOT NULL AND OLD.ack_at IS NULL AND EXISTS (SELECT 1 FROM outbox_events WHERE id=NEW.event_id AND activity_id='${activity.id}'::uuid)
      THEN RAISE EXCEPTION 'Scoped ACK storage failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER fail_ack BEFORE UPDATE ON live_deliveries FOR EACH ROW EXECUTE FUNCTION fail_ack_write()`);
  let eventId:string|null=null;
  try {
    await book(activity.id,actorId); await until(()=>client.messages.some(m=>m.eventId && m.version===2));
    const update=client.messages.find(m=>m.eventId && m.version===2)!; eventId=update.eventId; ack(client.socket,update);
    await until(async ()=>(await request('/metrics/live?includeTest=true')).data.instrumentation.measurementFailures>0);
    await book(activity.id,nextActor); await until(()=>client.messages.some(m=>m.version===3));
    assert.equal(client.socket.readyState,WebSocket.OPEN);
    await new Promise(resolve=>setTimeout(resolve,2100));
  } finally { await owner.query('DROP TRIGGER fail_ack ON live_deliveries; DROP FUNCTION fail_ack_write()'); }
  await until(async ()=>(await owner.query('SELECT ack_at,delay_ms FROM live_deliveries WHERE event_id=$1',[eventId])).rows.some(row=>row.ack_at && row.delay_ms<2000));
  client.socket.terminate();
});


test('mobile ACKs keep the guest journey and derive vouch lineage and assignment without contacts', async () => {
  const host = await actor();
  let activity: any;
  for (let attempt = 0; attempt < 30; attempt++) {
    activity = (await request('/activities', { title: 'Mobile vouch live test', description: 'Marked fixture', meetingLocation: 'Marina',
      startsAt: '2030-01-15T07:00:00Z', timezone: 'Africa/Lagos', capacity: 2, priceMinor: 0, currency: 'NGN' }, host)).data;
    if (activity.assignment.variant === 'treatment') break;
  }
  assert.equal(activity.assignment.variant, 'treatment');
  const contact = `live-${randomUUID()}@example.com`;
  const invite = (await request(`/activities/${activity.id}/invites`, { rail: 'vouch', recipientContact: contact, platform: 'web', journeyId: randomUUID() }, host)).data;
  const journeyId = randomUUID();
  const guest = (await request('/identities', { displayName: 'Mobile recipient', contact, inviteCode: invite.code, journeyId, platform: 'mobile' })).data;
  const mobile = await connect(activity.id, base, true, randomUUID(), true, { platform: 'mobile', journeyId, actorId: guest.id, inviteCode: invite.code });
  assert.equal(mobile.messages.find(m => m.version === 1)?.activity.inviteState, 'valid');
  const result = await request(`/invites/${invite.code}/claims`, { platform: 'mobile', journeyId }, guest.id);
  assert.equal(result.status, 201);
  await until(() => mobile.messages.some(m => m.eventId && m.version === 2));
  const update = mobile.messages.find(m => m.eventId && m.version === 2)!;
  ack(mobile.socket, update); ack(mobile.socket, update);
  await until(async () => (await owner.query("SELECT 1 FROM analytics_events WHERE name='availability_applied' AND journey_id=$1", [journeyId])).rowCount === 1);
  const { rows: applied } = await owner.query("SELECT * FROM analytics_events WHERE name='availability_applied' AND journey_id=$1", [journeyId]);
  assert.equal(applied.length, 1);
  assert.equal(applied[0].platform, 'mobile'); assert.equal(applied[0].actor_id, guest.id); assert.equal(applied[0].invite_id, invite.id);
  assert.equal(applied[0].context.rail, 'vouch'); assert.equal(applied[0].context.generation, 1);
  assert.deepEqual(applied[0].context.assignment, activity.assignment);
  assert.equal(JSON.stringify(applied).includes(contact), false);
  await owner.query("UPDATE activities SET status='cancelled' WHERE id=$1", [activity.id]);
  await until(() => mobile.messages.some(m => m.activity.inviteState === 'cancelled'));
  mobile.socket.terminate();
});
