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
interface Snapshot { type: string; activityId: string; eventId: string | null; version: number; confirmedCount: number; remainingSeats: number; activity: { participants: unknown[] } }
async function connect(activityId: string, api = base, foreground = true, clientId = randomUUID(), waitSnapshot = true) {
  const socket = new WebSocket(api.replace('http:', 'ws:').replace('/api', '/api/live'), { origin });
  clients.push(socket);
  const messages: Snapshot[] = [];
  socket.on('message', value => messages.push(JSON.parse(value.toString())));
  socket.on('error', () => {});
  await once(socket, 'open');
  socket.send(JSON.stringify({ type: 'subscribe', activityId, clientId, foreground }));
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
  assert.equal(exact.deliveryMisses, 1); assert.equal(exact.coverage, .5); assert.equal(exact.everyClientTargetMet, false);
  assert.ok(exact.perBookingP95Ms >= 0 && exact.perBookingP95Ms < 2000);
  assert.equal(exact.bookingsWithSubscribers, 1); assert.equal(exact.clients[0].samples, 1);
  assert.equal(proxyGroup.expectedDeliveries, 1); assert.equal(proxyGroup.acknowledged, 1);
  assert.equal(hidden.messages.some(m => m.eventId), false);
  const excluded = (await request('/metrics/live')).data.groups;
  assert.ok(excluded.every((g: Record<string, unknown>) => g.expectedDeliveries === 0 && g.coverage === null && g.everyClientTargetMet === null));
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
    assert.ok(exact.perBookingMaxima.find((m: { eventId: string }) => m.eventId === delivered.eventId).maximumMs >= 2200);
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
  assert.equal(exact.clients.find((c: { clientId: string }) => c.clientId === client.clientId).p95Ms, records.p95);
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
