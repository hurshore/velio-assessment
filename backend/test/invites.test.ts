import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { readFile } from 'node:fs/promises';
import { before, after, test } from 'node:test';
import pg from 'pg';
import { createApp } from '../src/app.js';
import type { InviteConfig } from '../src/experiments.js';
import { runMigrations } from '../src/migrations.js';

// Each run owns a new database; no demo data is removed by these checks.
// The pool stays small because other suites run concurrently against the same server.
const name = `velio_test_${randomUUID().replaceAll('-', '')}`;
const admin = new pg.Client({ connectionString: process.env.MIGRATION_DATABASE_URL });
let owner: pg.Pool;
let runtime: pg.Pool;
let server: ReturnType<ReturnType<typeof createApp>['listen']>;
let base: string;
const failures: unknown[] = [];
async function start(invites: InviteConfig) {
  if (server) await new Promise<void>(resolve => server.close(() => resolve()));
  server = createApp({ invites, postgres: runtime, redis: { ping: async () => 'PONG' } }, 'http://localhost:5173', (_context, error) => { failures.push(error); })
    .listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
}
before(async () => {
  assert.ok(process.env.MIGRATION_DATABASE_URL && process.env.DATABASE_URL, 'Run npm run setup and npm run infra:up first');
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  function url(value: string) { const url = new URL(value); url.pathname = `/${name}`; return url.href; }
  const migrationUrl = url(process.env.MIGRATION_DATABASE_URL!);
  await runMigrations(new pg.Client({ connectionString: migrationUrl }), new URL('../migrations/', import.meta.url).pathname);
  owner = new pg.Pool({ connectionString: migrationUrl });
  runtime = new pg.Pool({ connectionString: url(process.env.DATABASE_URL!), max: 25, connectionTimeoutMillis: 3000 });
  await start({ version: 'invites', treatmentPercent: 100, creationEnabled: true });
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
async function identity(extra: Record<string, unknown> = {}, journeyId = randomUUID()) {
  const result = await request('/identities', { displayName: 'Synthetic guest', journeyId, platform: 'mobile', test: true, ...extra });
  assert.equal(result.status, 201, JSON.stringify(result));
  return result.data;
}
async function activity(host: string, capacity = 3, startsAt = '2030-01-15T07:00:00Z') {
  const result = await request('/activities', { title: 'Invite test', description: 'Synthetic invite scenario', meetingLocation: 'Test gate',
    startsAt, timezone: 'Africa/Lagos', capacity, priceMinor: 1500, currency: 'NGN' }, host);
  assert.equal(result.status, 201, JSON.stringify(result));
  return result.data;
}
function share(activityId: string, actor: string) {
  return request(`/activities/${activityId}/invites`, { rail: 'public', platform: 'web' }, actor);
}

test('a host creates an opaque public link that expires within 24 hours and reserves no seat', async () => {
  const host = (await identity()).id;
  const listing = await activity(host);
  const result = await share(listing.id, host);
  assert.equal(result.status, 201, JSON.stringify(result));
  assert.match(result.data.code, /^[0-9A-HJKMNP-TV-Z]{12}$/);
  assert.equal(result.data.rail, 'public');
  assert.equal(result.data.inviterRole, 'host');
  assert.equal(result.data.activityId, listing.id);
  const lifetime = Date.parse(result.data.expiresAt) - Date.parse(result.data.createdAt);
  assert.equal(lifetime, 24 * 60 * 60 * 1000);
  assert.equal(result.data.availability.remainingSeats, 3);
  assert.equal((await request(`/activities/${listing.id}`)).data.remainingSeats, 3);
  assert.notEqual((await share(listing.id, host)).data.code, result.data.code);
});

function book(activityId: string, actor: string, key = randomUUID()) {
  return request(`/activities/${activityId}/bookings`, { platform: 'web', journeyId: randomUUID() }, actor, key);
}

test('creation requires a host or confirmed booker in treatment with the creation switch on', async () => {
  const host = (await identity()).id;
  const booker = (await identity()).id;
  const outsider = (await identity()).id;
  const listing = await activity(host);
  assert.equal((await share(listing.id, outsider)).error.code, 'INVITE_CREATION_UNAVAILABLE');
  assert.equal((await share(listing.id, randomUUID())).status, 401);
  assert.equal((await book(listing.id, booker)).status, 201);
  const booked = await share(listing.id, booker);
  assert.equal(booked.status, 201);
  assert.equal(booked.data.inviterRole, 'booker');
  assert.equal((await request(`/activities/${listing.id}/invites`, { rail: 'public', platform: 'web', inviterId: host }, booker)).status, 400);
  assert.equal((await request(`/activities/${listing.id}/invites`, { rail: 'vouch', platform: 'web' }, booker)).status, 400);
  await start({ version: 'invites-control', treatmentPercent: 0, creationEnabled: true });
  try {
    const control = await activity(host);
    assert.equal(control.assignment.variant, 'control');
    assert.equal((await share(control.id, host)).error.code, 'INVITE_CREATION_UNAVAILABLE');
    await start({ version: 'invites', treatmentPercent: 100, creationEnabled: false });
    assert.equal((await share(listing.id, host)).error.code, 'INVITE_CREATION_UNAVAILABLE');
    assert.equal((await share(listing.id, booker)).status, 403);
  } finally { await start({ version: 'invites', treatmentPercent: 100, creationEnabled: true }); }
});

test('expiry is capped at activity start, and full, started or cancelled activities cannot be shared', async () => {
  const host = (await identity()).id;
  const soon = new Date(Date.now() + 60 * 60 * 1000);
  soon.setUTCMilliseconds(0);
  const early = await activity(host, 2, soon.toISOString().replace('.000Z', 'Z'));
  assert.equal(Date.parse((await share(early.id, host)).data.expiresAt), soon.getTime());
  const full = await activity(host, 1);
  assert.equal((await book(full.id, (await identity()).id)).status, 201);
  assert.equal((await share(full.id, host)).error.code, 'SOLD_OUT');
  const started = await activity(host);
  await owner.query("UPDATE activities SET starts_at=now() - interval '1 minute' WHERE id=$1", [started.id]);
  assert.equal((await share(started.id, host)).error.code, 'ACTIVITY_STARTED');
  const cancelled = await activity(host);
  await owner.query("UPDATE activities SET status='cancelled' WHERE id=$1", [cancelled.id]);
  assert.equal((await share(cancelled.id, host)).error.code, 'ACTIVITY_UNAVAILABLE');
});

test('invite_created persists with server-derived rail, generation, platform and assignment', async () => {
  const host = (await identity({ test: false })).id;
  const listing = await activity(host);
  const journeyId = randomUUID();
  const created = (await request(`/activities/${listing.id}/invites`, { rail: 'public', platform: 'web', journeyId }, host)).data;
  const events = (await owner.query("SELECT * FROM analytics_events WHERE invite_id=$1 AND name='invite_created'", [created.id])).rows;
  assert.equal(events.length, 1);
  assert.equal(events[0].platform, 'web');
  assert.equal(events[0].journey_id, journeyId);
  assert.equal(events[0].actor_id, host);
  assert.equal(events[0].context.rail, 'public');
  assert.equal(events[0].context.generation, 0);
  assert.equal(events[0].context.inviterRole, 'host');
  assert.deepEqual(events[0].context.assignment, listing.assignment);
});

async function eventCount(sql: string, parameters: unknown[]) {
  return (await owner.query(`SELECT count(*)::int AS n FROM analytics_events WHERE ${sql}`, parameters)).rows[0].n;
}

test('preview distinguishes valid, full, expired, started, cancelled and invalid codes without recording opens', async () => {
  const host = await identity({ displayName: 'Amara preview host' });
  const listing = await activity(host.id, 1);
  const created = (await share(listing.id, host.id)).data;
  const preview = await request(`/invites/${created.code}`);
  assert.equal(preview.status, 200);
  assert.equal(preview.data.state, 'valid');
  assert.equal(preview.data.code, created.code);
  assert.equal(preview.data.rail, 'public');
  assert.equal(preview.data.trust, 'public');
  assert.deepEqual(preview.data.inviter, { displayName: 'Amara preview host', role: 'host' });
  assert.equal(preview.data.activity.id, listing.id);
  assert.equal(preview.data.activity.meetingLocation, 'Test gate');
  assert.equal(preview.data.activity.remainingSeats, 1);
  assert.equal(preview.data.expiresAt, created.expiresAt);
  assert.equal(JSON.stringify(preview.data).includes(host.id), false, 'Public preview must not expose inviter identifiers');
  const normalized = `${created.code.slice(0, 4).toLowerCase()}-${created.code.slice(4, 8)} ${created.code.slice(8)}`;
  assert.equal((await request(`/invites/${encodeURIComponent(normalized)}`)).data.code, created.code);
  assert.equal((await book(listing.id, (await identity()).id)).status, 201);
  assert.equal((await request(`/invites/${created.code}`)).data.state, 'full');
  for (const [scenario, sql] of [['expired', ''],
    ['started', "UPDATE activities SET starts_at=now() - interval '1 minute' WHERE id=$1"],
    ['cancelled', "UPDATE activities SET status='cancelled' WHERE id=$1"]] as const) {
    const fresh = await activity(host.id, 2);
    const code = (await share(fresh.id, host.id)).data.code;
    if (scenario === 'expired') await owner.query(`ALTER TABLE invites DISABLE TRIGGER invites_append_only;
      UPDATE invites SET created_at=now() - interval '25 hours', expires_at=now() - interval '1 hour' WHERE code='${code}';
      ALTER TABLE invites ENABLE TRIGGER invites_append_only`);
    else await owner.query(sql, [fresh.id]);
    assert.equal((await request(`/invites/${code}`)).data.state, scenario);
  }
  for (const code of ['ZZZZZZZZZZZZ', 'not-a-code', 'I0I0I0I0I0I0']) {
    const result = await request(`/invites/${code}`);
    assert.equal(result.status, 404);
    assert.equal(result.error.code, 'INVALID_INVITE');
  }
  assert.equal(await eventCount("name='invite_opened' AND invite_id=$1", [created.id]), 0);
});

function claim(code: string, actor: string, key = randomUUID(), journeyId = randomUUID()) {
  return request(`/invites/${code}/claims`, { platform: 'mobile', journeyId }, actor, key);
}
async function reconcile(activityId: string, expected: number) {
  const state = (await owner.query('SELECT * FROM booking_reconciliation WHERE activity_id=$1', [activityId])).rows[0];
  assert.equal(state.booking_count, expected);
  assert.equal(state.counter_mismatch, false);
  assert.equal(state.oversold, false);
}

test('distinct public guests claim while capacity remains, with server-derived redemption and safe replay', async () => {
  const host = (await identity()).id;
  const listing = await activity(host, 2);
  const { code, id: inviteId } = (await share(listing.id, host)).data;
  const [first, second, late] = [(await identity()).id, (await identity()).id, (await identity()).id];
  const key = randomUUID();
  const claimed = await claim(code, first, key);
  assert.equal(claimed.status, 201, JSON.stringify(claimed));
  assert.equal(claimed.data.replayed, false);
  assert.equal(claimed.data.booking.userId, first);
  assert.equal(claimed.data.booking.planId, listing.planId);
  assert.equal(claimed.data.availability.remainingSeats, 1);
  assert.deepEqual({ ...claimed.data.redemption, id: undefined, createdAt: undefined },
    { id: undefined, createdAt: undefined, inviteId, rail: 'public', inviteeGeneration: 0, bookingId: claimed.data.booking.id });
  assert.equal((await claim(code, second)).status, 201);
  const soldOut = await claim(code, late);
  assert.equal(soldOut.status, 409);
  assert.equal(soldOut.error.code, 'SOLD_OUT');
  // Booking recovery takes precedence over the full state, by key or by membership.
  for (const retry of [await claim(code, first, key), await claim(code, first)]) {
    assert.equal(retry.status, 200);
    assert.equal(retry.data.replayed, true);
    assert.equal(retry.data.booking.id, claimed.data.booking.id);
    assert.equal(retry.data.redemption.id, claimed.data.redemption.id);
  }
  const edges = (await owner.query('SELECT * FROM invite_redemptions WHERE invite_id=$1 ORDER BY created_at', [inviteId])).rows;
  assert.deepEqual(edges.map(edge => [edge.inviter_id, edge.invitee_id, edge.rail]), [[host, first, 'public'], [host, second, 'public']]);
  await reconcile(listing.id, 2);
});

test('self-invites, expired codes and invalid codes consume neither a seat nor a redemption', async () => {
  const host = (await identity()).id;
  const listing = await activity(host, 2);
  const { code, id: inviteId } = (await share(listing.id, host)).data;
  const self = await claim(code, host);
  assert.equal(self.status, 403);
  assert.equal(self.error.code, 'SELF_INVITE');
  assert.equal((await claim('ZZZZZZZZZZZZ', host)).error.code, 'INVALID_INVITE');
  await owner.query(`ALTER TABLE invites DISABLE TRIGGER invites_append_only;
    UPDATE invites SET created_at=now() - interval '25 hours', expires_at=now() - interval '1 hour' WHERE id='${inviteId}';
    ALTER TABLE invites ENABLE TRIGGER invites_append_only`);
  const expired = await claim(code, (await identity()).id);
  assert.equal(expired.status, 410);
  assert.equal(expired.error.code, 'INVITE_EXPIRED');
  assert.equal((await owner.query('SELECT count(*)::int AS n FROM invite_redemptions WHERE invite_id=$1', [inviteId])).rows[0].n, 0);
  await reconcile(listing.id, 0);
});

test('an existing direct booking is recovered without a redemption or changed attribution', async () => {
  const host = (await identity()).id;
  const guest = (await identity()).id;
  const listing = await activity(host, 2);
  const direct = await book(listing.id, guest);
  const { code } = (await share(listing.id, host)).data;
  const recovered = await claim(code, guest);
  assert.equal(recovered.status, 200);
  assert.equal(recovered.data.replayed, true);
  assert.equal(recovered.data.booking.id, direct.data.booking.id);
  assert.equal(recovered.data.redemption, null);
  assert.equal((await owner.query('SELECT count(*)::int AS n FROM invite_redemptions WHERE booking_id=$1', [direct.data.booking.id])).rows[0].n, 0);
  await reconcile(listing.id, 1);
});

test('organic -> invited -> invited signups freeze generation, parent, root and rail; returning users keep history', async () => {
  const amara = await identity({ displayName: 'Amara organic root' });
  assert.equal(amara.generation, 0);
  const listing = await activity(amara.id, 4);
  const first = (await share(listing.id, amara.id)).data;
  const kemiJourney = randomUUID();
  const kemi = await identity({ displayName: 'Kemi invited', inviteCode: first.code }, kemiJourney);
  assert.deepEqual([kemi.generation, kemi.acquisitionParentId, kemi.acquisitionRootId, kemi.acquisitionRail], [1, amara.id, amara.id, 'public']);
  const kemiClaim = await claim(first.code, kemi.id, randomUUID(), kemiJourney);
  assert.equal(kemiClaim.data.redemption.inviteeGeneration, 1);
  const second = (await share(listing.id, kemi.id)).data;
  const snapshot = (await owner.query('SELECT inviter_generation,inviter_parent_id,inviter_root_id,invitee_generation FROM invites WHERE id=$1', [second.id])).rows[0];
  assert.deepEqual(snapshot, { inviter_generation: 1, inviter_parent_id: amara.id, inviter_root_id: amara.id, invitee_generation: 2 });
  const zainab = await identity({ displayName: 'Zainab invited', inviteCode: second.code.toLowerCase() });
  assert.deepEqual([zainab.generation, zainab.acquisitionParentId, zainab.acquisitionRootId, zainab.acquisitionRail], [2, kemi.id, amara.id, 'public']);
  const attribution = (await owner.query('SELECT generation,parent_id,root_id,rail,invite_id FROM signup_attribution WHERE user_id=$1', [zainab.id])).rows[0];
  assert.deepEqual(attribution, { generation: 2, parent_id: kemi.id, root_id: amara.id, rail: 'public', invite_id: second.id });
  const created = (await owner.query("SELECT journey_id,invite_id,context FROM analytics_events WHERE actor_id=$1 AND name='identity_created'", [kemi.id])).rows[0];
  assert.equal(created.journey_id, kemiJourney);
  assert.equal(created.invite_id, first.id);
  assert.deepEqual([created.context.generation, created.context.rail, created.context.acquisitionParentId], [1, 'public', amara.id]);
  // Zainab signed up but never claimed: a signup, not an activated guest.
  assert.equal(await eventCount("actor_id=$1 AND name='spot_claimed'", [zainab.id]), 0);
  const returning = await identity({ displayName: 'Returning organic' });
  const returningClaim = await claim(second.code, returning.id);
  assert.equal(returningClaim.data.redemption.inviteeGeneration, 0);
  const after = (await request(`/identities/${returning.id}`)).data;
  assert.deepEqual([after.generation, after.acquisitionParentId, after.acquisitionRootId, after.acquisitionRail], [0, null, returning.id, null]);
});

test('signup invite context must be a live issued code and attribution fields cannot be supplied', async () => {
  const host = (await identity()).id;
  const listing = await activity(host);
  const { code, id } = (await share(listing.id, host)).data;
  assert.equal((await request('/identities', { displayName: 'Forged', journeyId: randomUUID(), platform: 'mobile', generation: 5 })).status, 400);
  assert.equal((await request('/identities', { displayName: 'Forged', journeyId: randomUUID(), platform: 'mobile', inviteCode: code, acquisitionParentId: host })).status, 400);
  const unknown = await request('/identities', { displayName: 'Unknown code', journeyId: randomUUID(), platform: 'mobile', inviteCode: 'ZZZZZZZZZZZZ' });
  assert.equal(unknown.error.code, 'INVALID_INVITE');
  await owner.query(`ALTER TABLE invites DISABLE TRIGGER invites_append_only;
    UPDATE invites SET created_at=now() - interval '25 hours', expires_at=now() - interval '1 hour' WHERE id='${id}';
    ALTER TABLE invites ENABLE TRIGGER invites_append_only`);
  const expired = await request('/identities', { displayName: 'Expired code', journeyId: randomUUID(), platform: 'mobile', inviteCode: code });
  assert.equal(expired.status, 410);
  assert.equal(expired.error.code, 'INVITE_EXPIRED');
});

test('runtime credentials cannot rewrite history or forge ancestry; corrections append explanations', async () => {
  const host = await identity();
  const listing = await activity(host.id);
  const invite = (await share(listing.id, host.id)).data;
  const guest = await identity({ inviteCode: invite.code });
  const claimed = (await claim(invite.code, guest.id)).data;
  for (const sql of [`UPDATE invites SET inviter_generation=4 WHERE id='${invite.id}'`, `DELETE FROM invites WHERE id='${invite.id}'`,
    `UPDATE invite_redemptions SET invitee_generation=4 WHERE id='${claimed.redemption.id}'`, `DELETE FROM invite_redemptions WHERE id='${claimed.redemption.id}'`,
    `UPDATE users SET acquisition_parent_id=NULL WHERE id='${guest.id}'`, `UPDATE signup_attribution SET rail='vouch' WHERE user_id='${guest.id}'`,
    `INSERT INTO attribution_corrections (subject,subject_id,reason) VALUES ('invite','${invite.id}','Runtime cannot correct')`]) {
    await assert.rejects(runtime.query(sql), /permission denied/, sql);
  }
  // Ordinary migration-role statements are refused too; only an appended correction explains a fix.
  await assert.rejects(owner.query('UPDATE invites SET inviter_generation=4 WHERE id=$1', [invite.id]), /append-only/);
  await assert.rejects(owner.query('UPDATE users SET generation=5 WHERE id=$1', [guest.id]), /immutable/);
  await owner.query('UPDATE users SET display_name=$1 WHERE id=$2', ['Renamed guest', guest.id]);
  const [correction] = (await owner.query(`INSERT INTO attribution_corrections (subject,subject_id,reason,correction)
    VALUES ('invite_redemption',$1,'Support confirmed a duplicate demo account',$2) RETURNING id`, [claimed.redemption.id, { excludeFromK: true }])).rows;
  await assert.rejects(owner.query('DELETE FROM attribution_corrections WHERE id=$1', [correction.id]), /append-only/);
  assert.equal((await runtime.query('SELECT reason FROM attribution_corrections WHERE subject_id=$1', [claimed.redemption.id])).rows[0].reason, 'Support confirmed a duplicate demo account');
  // Runtime inserts must match stored snapshots exactly.
  const outsider = await identity();
  await assert.rejects(runtime.query(`INSERT INTO users (id,display_name,generation,acquisition_parent_id,acquisition_root_id,acquisition_invite_id,acquisition_rail)
    VALUES ($1,'Forged child',7,$2,$2,$3,'public')`, [randomUUID(), host.id, invite.id]), /users_acquisition_invite_fk/);
  await assert.rejects(runtime.query(`INSERT INTO invites (id,code,activity_id,plan_id,inviter_id,inviter_role,rail,inviter_generation,inviter_root_id,invitee_generation,expires_at)
    VALUES ($1,'ABCDEFGHJKMN',$2,$3,$4,'host','public',0,$5,1,now() + interval '1 hour')`, [randomUUID(), listing.id, listing.planId, host.id, outsider.id]), /foreign key/);
  await assert.rejects(runtime.query(`INSERT INTO invite_redemptions (id,invite_id,activity_id,inviter_id,rail,invitee_id,invitee_generation,booking_id)
    VALUES ($1,$2,$3,$4,'public',$5,0,$6)`, [randomUUID(), invite.id, listing.id, outsider.id, guest.id, claimed.booking.id]), /foreign key|unique/);
});

test('direct bookings and public claims race for the same seats without overselling', async () => {
  const host = (await identity()).id;
  const listing = await activity(host, 3);
  const { code, id: inviteId } = (await share(listing.id, host)).data;
  const actors = await Promise.all(Array.from({ length: 30 }, async () => (await identity()).id));
  const lock = await owner.connect();
  await lock.query('BEGIN');
  await lock.query('SELECT id FROM activities WHERE id=$1 FOR UPDATE', [listing.id]);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const requests = actors.map(async (actor, index) => { await gate; return index % 2 ? claim(code, actor) : book(listing.id, actor); });
  release();
  try {
    let overlap = 0;
    const deadline = Date.now() + 1000;
    while (Date.now() < deadline && overlap < 10) {
      overlap = (await owner.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=$1 AND wait_event_type='Lock'", [name])).rows[0].n;
      if (overlap < 10) await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.ok(overlap >= 10, `Expected overlapping transactions, saw ${overlap}`);
  } finally { await lock.query('ROLLBACK'); lock.release(); }
  const outcomes = await Promise.all(requests);
  const won = outcomes.filter(result => result.status === 201);
  assert.equal(won.length, 3);
  assert.equal(outcomes.filter(result => result.status === 409 && result.error.code === 'SOLD_OUT').length, 27);
  await reconcile(listing.id, 3);
  const claimedSeats = won.filter(result => result.data.redemption).length;
  assert.equal((await owner.query('SELECT count(*)::int AS n FROM invite_redemptions WHERE invite_id=$1', [inviteId])).rows[0].n, claimedSeats);
  assert.equal(await eventCount("invite_id=$1 AND name='spot_claimed'", [inviteId]), claimedSeats);
});

test('concurrent duplicate claims by one guest commit one booking and one redemption', async () => {
  const host = (await identity()).id;
  const guest = (await identity()).id;
  const listing = await activity(host, 3);
  const { code, id: inviteId } = (await share(listing.id, host)).data;
  const key = randomUUID();
  const outcomes = await Promise.all([...Array.from({ length: 8 }, () => claim(code, guest, key)), ...Array.from({ length: 8 }, () => claim(code, guest))]);
  assert.equal(outcomes.filter(result => result.status === 201).length, 1);
  assert.equal(new Set(outcomes.map(result => result.data.booking.id)).size, 1);
  assert.equal(new Set(outcomes.map(result => result.data.redemption.id)).size, 1);
  assert.equal((await owner.query('SELECT count(*)::int AS n FROM invite_redemptions WHERE invite_id=$1', [inviteId])).rows[0].n, 1);
  assert.equal(await eventCount("invite_id=$1 AND name='spot_claimed'", [inviteId]), 1);
  const mismatch = await request(`/invites/${(await share(listing.id, host)).data.code}/claims`, { platform: 'mobile', journeyId: randomUUID() }, guest, key);
  assert.equal(mismatch.error.code, 'IDEMPOTENCY_MISMATCH');
  await reconcile(listing.id, 1);
});

test('a failure before commit rolls back the booking, count and redemption but keeps attempt telemetry', async () => {
  const host = (await identity()).id;
  const guest = (await identity()).id;
  const listing = await activity(host, 2);
  const { code, id: inviteId } = (await share(listing.id, host)).data;
  const key = randomUUID();
  await owner.query(`CREATE FUNCTION fail_test_redemption() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.invite_id='${inviteId}'::uuid THEN RAISE EXCEPTION 'Injected redemption failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER fail_test_redemption BEFORE INSERT ON invite_redemptions FOR EACH ROW EXECUTE FUNCTION fail_test_redemption()`);
  try {
    const failed = await claim(code, guest, key);
    assert.equal(failed.status, 500);
    assert.equal(failed.error.retryable, true);
    await reconcile(listing.id, 0);
    assert.equal((await owner.query('SELECT confirmed_count,version FROM activities WHERE id=$1', [listing.id])).rows[0].version, 1);
    assert.equal(await eventCount("invite_id=$1 AND name IN ('spot_claimed','booking_succeeded')", [inviteId]), 0);
    assert.equal(await eventCount("invite_id=$1 AND actor_id=$2 AND name='invite_claim_attempted'", [inviteId, guest]), 1);
    assert.equal(await eventCount("invite_id=$1 AND actor_id=$2 AND name='booking_failed' AND context->>'operation'='claim_invite'", [inviteId, guest]), 1);
  } finally { await owner.query('DROP TRIGGER fail_test_redemption ON invite_redemptions; DROP FUNCTION fail_test_redemption()'); }
  assert.equal((await claim(code, guest, key)).status, 201);
  await reconcile(listing.id, 1);
});

test('issued links keep resolving and claiming after creation is switched off', async () => {
  const host = (await identity()).id;
  const listing = await activity(host, 2);
  const { code } = (await share(listing.id, host)).data;
  await start({ version: 'switched-off', treatmentPercent: 0, creationEnabled: false });
  try {
    assert.equal((await share(listing.id, host)).status, 403);
    assert.equal((await request(`/invites/${code}`)).data.state, 'valid');
    assert.equal((await claim(code, (await identity({ inviteCode: code })).id)).status, 201);
  } finally { await start({ version: 'invites', treatmentPercent: 100, creationEnabled: true }); }
});

test('claims are accepted shortly before expiry and rejected after it', async () => {
  const host = (await identity()).id;
  const listing = await activity(host, 3);
  const { code, id } = (await share(listing.id, host)).data;
  await owner.query(`ALTER TABLE invites DISABLE TRIGGER invites_append_only;
    UPDATE invites SET created_at=clock_timestamp() - interval '23 hours 59 minutes', expires_at=clock_timestamp() + interval '700 milliseconds' WHERE id='${id}';
    ALTER TABLE invites ENABLE TRIGGER invites_append_only`);
  assert.equal((await claim(code, (await identity()).id)).status, 201);
  await new Promise(resolve => setTimeout(resolve, 800));
  assert.equal((await claim(code, (await identity()).id)).error.code, 'INVITE_EXPIRED');
  assert.equal((await request(`/invites/${code}`)).data.state, 'expired');
  await reconcile(listing.id, 1);
});

function opened(code: string, journeyId: string, displayedState: string, extra: Record<string, unknown> = {}) {
  return { id: randomUUID(), schemaVersion: 1, name: 'invite_opened', occurredAt: new Date().toISOString(), source: 'client', platform: 'mobile',
    journeyId, inviteCode: code, displayedState, ...extra };
}

test('a persistent guest journey links rendered opens to identity and committed claim with server context', async () => {
  const host = (await identity()).id;
  const listing = await activity(host, 1);
  const { code, id: inviteId } = (await share(listing.id, host)).data;
  const journeyId = randomUUID();
  const open = opened(code, journeyId, 'valid');
  assert.deepEqual((await request('/events', open)).data, { id: open.id, accepted: true });
  assert.equal((await request('/events', open)).data.accepted, false);
  for (const forged of [{ rail: 'vouch' }, { generation: 3 }, { inviterId: host }, { displayedState: 'reserved' }, { journeyId: undefined }]) {
    assert.equal((await request('/events', { ...opened(code, journeyId, 'valid'), ...forged })).status, 400, JSON.stringify(forged));
  }
  assert.equal((await request('/events', opened('ZZZZZZZZZZZZ', journeyId, 'valid'))).error.code, 'INVALID_INVITE');
  const stored = (await owner.query('SELECT * FROM analytics_events WHERE id=$1', [open.id])).rows[0];
  assert.deepEqual([stored.invite_id, stored.activity_id, stored.plan_id, stored.journey_id, stored.platform, stored.source],
    [inviteId, listing.id, listing.planId, journeyId, 'mobile', 'client']);
  assert.deepEqual([stored.context.rail, stored.context.inviterGeneration, stored.context.displayedState, stored.context.stateAtReceipt, stored.context.recovery],
    ['public', 0, 'valid', 'valid', false]);
  assert.deepEqual(stored.context.assignment, listing.assignment);
  const guest = await identity({ inviteCode: code }, journeyId);
  const key = randomUUID();
  assert.equal((await claim(code, guest.id, key, journeyId)).status, 201);
  const journey = (await owner.query(`SELECT name,platform,context FROM analytics_events WHERE journey_id=$1 ORDER BY occurred_at`, [journeyId])).rows;
  for (const name of ['invite_opened', 'identity_created', 'invite_claim_attempted', 'spot_claimed']) {
    const event = journey.find(row => row.name === name);
    assert.ok(event, `${name} missing from the guest journey`);
    assert.equal(event.platform, 'mobile');
    assert.equal(event.context.rail, 'public');
  }
  const spot = journey.find(row => row.name === 'spot_claimed')!;
  assert.deepEqual([spot.context.generation, spot.context.operation], [1, 'claim_invite']);
  assert.deepEqual(spot.context.assignment, listing.assignment);
  // Reopening a confirmed seat is recovery traffic, not a new acquisition or claim success.
  const reopen = opened(code, journeyId, 'full', { actorId: guest.id });
  const reopenResponse = await fetch(`${base}/events`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Demo-Actor-Id': guest.id }, body: JSON.stringify(reopen) });
  assert.equal(reopenResponse.status, 202);
  const recovered = (await owner.query('SELECT actor_id,context FROM analytics_events WHERE id=$1', [reopen.id])).rows[0];
  assert.deepEqual([recovered.actor_id, recovered.context.recovery, recovered.context.stateAtReceipt], [guest.id, true, 'full']);
  assert.equal((await claim(code, guest.id, randomUUID(), journeyId)).status, 200);
  assert.equal(await eventCount("journey_id=$1 AND name='spot_claimed'", [journeyId]), 1);
  const outcome = (await owner.query(`SELECT context FROM analytics_events WHERE journey_id=$1 AND name='booking_request_outcome' ORDER BY occurred_at DESC LIMIT 1`, [journeyId])).rows[0];
  assert.deepEqual([outcome.context.outcome, outcome.context.operation], ['replay', 'claim_invite']);
  // A different guest's open of the now-full link stays observable.
  const fullOpen = opened(code, randomUUID(), 'full');
  assert.equal((await request('/events', fullOpen)).data.accepted, true);
});

test('labelled attribution seeds replay without changes and describe an organic -> invited -> invited chain', async () => {
  const seeds = await Promise.all(['host.sql', 'invites.sql'].map(file => readFile(new URL(`../seeds/${file}`, import.meta.url), 'utf8')));
  const snapshot = async () => (await owner.query(`SELECT (SELECT jsonb_agg(u ORDER BY u.id) FROM users u WHERE u.id::text LIKE 'a1000000-%') AS users,
    (SELECT jsonb_agg(r ORDER BY r.id) FROM invite_redemptions r WHERE r.activity_id='b5000000-0000-4000-8000-000000000001') AS redemptions,
    (SELECT count(*) FROM analytics_events WHERE activity_id='b5000000-0000-4000-8000-000000000001') AS events`)).rows[0];
  for (const sql of seeds) await owner.query(sql);
  const first = await snapshot();
  for (const sql of seeds) await owner.query(sql);
  assert.deepEqual(await snapshot(), first);
  const chain = (await request('/identities')).data.filter((user: { id: string }) => user.id.startsWith('a1000000-'));
  const byName = Object.fromEntries(chain.map((user: { displayName: string }) => [user.displayName.split(' ')[0], user]));
  assert.deepEqual([byName.Amara.generation, byName.Kemi.generation, byName.Zainab.generation, byName.Tunde.generation], [0, 1, 2, 0]);
  assert.equal(byName.Zainab.acquisitionParentId, byName.Kemi.id);
  assert.equal(byName.Zainab.acquisitionRootId, byName.Amara.id);
  const edges = (await owner.query(`SELECT r.inviter_id, r.invitee_id, r.invitee_generation, i.code FROM invite_redemptions r JOIN invites i ON i.id=r.invite_id
    WHERE r.activity_id='b5000000-0000-4000-8000-000000000001' ORDER BY r.created_at`)).rows;
  assert.deepEqual(edges.map(edge => [edge.inviter_id, edge.invitee_id, edge.invitee_generation]),
    [[byName.Amara.id, byName.Kemi.id, 1], [byName.Amara.id, byName.Tunde.id, 0], [byName.Kemi.id, byName.Zainab.id, 2]]);
  await reconcile('b5000000-0000-4000-8000-000000000001', 3);
  assert.equal((await request(`/invites/${edges[0].code}`)).data.state, 'expired');
  const events = (await owner.query("SELECT name,synthetic,context FROM analytics_events WHERE activity_id='b5000000-0000-4000-8000-000000000001'")).rows;
  assert.ok(events.every(event => event.synthetic && event.context.seedScenario === 'attribution-chain'));
  assert.equal(events.filter(event => event.name === 'spot_claimed').length, 3);
  assert.equal(events.filter(event => event.name === 'invite_claim_attempted').length, 3);
  assert.ok(events.some(event => event.name === 'invite_opened' && event.context.displayedState === 'expired'));
});

test('invite signups carry experiment context and a cancelled activity link does not stamp acquisition', async () => {
  const host = (await identity()).id;
  const listing = await activity(host);
  const { code, id } = (await share(listing.id, host)).data;
  const guest = await identity({ inviteCode: code });
  const created = (await owner.query("SELECT activity_id,plan_id,context FROM analytics_events WHERE actor_id=$1 AND name='identity_created'", [guest.id])).rows[0];
  assert.deepEqual([created.activity_id, created.plan_id], [listing.id, listing.planId]);
  assert.deepEqual(created.context.assignment, listing.assignment);
  const organic = await identity();
  const organicEvent = (await owner.query("SELECT activity_id,context FROM analytics_events WHERE actor_id=$1 AND name='identity_created'", [organic.id])).rows[0];
  assert.equal(organicEvent.activity_id, null);
  assert.equal('assignment' in organicEvent.context, false);
  await owner.query("UPDATE activities SET status='cancelled' WHERE id=$1", [listing.id]);
  const cancelled = await request('/identities', { displayName: 'Cancelled link', journeyId: randomUUID(), platform: 'mobile', inviteCode: code });
  assert.equal(cancelled.status, 409);
  assert.equal(cancelled.error.code, 'ACTIVITY_UNAVAILABLE');
  assert.equal((await owner.query('SELECT count(*)::int AS n FROM users WHERE acquisition_invite_id=$1', [id])).rows[0].n, 1);
});

test('creation racing the activity start returns ACTIVITY_STARTED, never a technical error', async () => {
  const host = (await identity()).id;
  const listing = await activity(host);
  await owner.query("UPDATE activities SET starts_at=clock_timestamp() + interval '150 milliseconds' WHERE id=$1", [listing.id]);
  const outcomes: { status: number; code?: string }[] = [];
  const deadline = Date.now() + 1500;
  while (Date.now() < deadline && !outcomes.some(outcome => outcome.status === 409)) {
    const result = await share(listing.id, host);
    outcomes.push({ status: result.status, code: result.error?.code });
  }
  assert.ok(outcomes.every(outcome => outcome.status === 201 || (outcome.status === 409 && outcome.code === 'ACTIVITY_STARTED')), JSON.stringify(outcomes));
  assert.ok(outcomes.some(outcome => outcome.status === 409));
});

test('a missing plan is reported as its own cause rather than a code collision', async () => {
  const host = (await identity()).id;
  const listing = await activity(host);
  await owner.query('DELETE FROM plans WHERE activity_id=$1', [listing.id]);
  failures.length = 0;
  const result = await share(listing.id, host);
  assert.equal(result.status, 500);
  assert.equal(failures.length, 1);
  assert.match(String((failures[0] as Error).message), /plan/i);
  assert.doesNotMatch(String((failures[0] as Error).message), /unique invite code/);
});

test('an organic guest claiming through a synthetic inviter inherits trusted markers on every invite event', async () => {
  const host = (await identity({ test: false })).id;
  const listing = await activity(host);
  const inviter = (await identity({ synthetic: true, test: true })).id;
  assert.equal((await book(listing.id, inviter)).status, 201);
  const { code, id: inviteId } = (await share(listing.id, inviter)).data;
  const guest = (await identity({ test: false })).id;
  const journeyId = randomUUID();
  assert.equal((await request('/events', opened(code, journeyId, 'valid'))).status, 202);
  assert.equal((await claim(code, guest, randomUUID(), journeyId)).status, 201);
  const signup = await identity({ test: false, inviteCode: code }, journeyId);
  assert.deepEqual([signup.synthetic, signup.test], [true, true]);
  const events = (await owner.query('SELECT name,synthetic,test FROM analytics_events WHERE invite_id=$1 AND name <> $2', [inviteId, 'invite_created'])).rows;
  for (const name of ['invite_opened', 'booking_attempted', 'invite_claim_attempted', 'booking_succeeded', 'spot_claimed', 'booking_request_outcome', 'identity_created']) {
    assert.ok(events.some(event => event.name === name), `${name} missing`);
  }
  assert.ok(events.every(event => event.synthetic && event.test), JSON.stringify(events));
  // A synthetic host likewise marks an organic inviter's link events, including the signup event.
  const labelledHost = (await identity({ synthetic: true, test: true })).id;
  const hosted = await activity(labelledHost);
  const organicBooker = (await identity({ test: false })).id;
  assert.equal((await book(hosted.id, organicBooker)).status, 201);
  const hostedLink = (await share(hosted.id, organicBooker)).data;
  const hostedSignup = await identity({ test: false, inviteCode: hostedLink.code });
  assert.deepEqual([hostedSignup.synthetic, hostedSignup.test], [false, false]);
  const [signupEvent] = (await owner.query("SELECT synthetic,test FROM analytics_events WHERE actor_id=$1 AND name='identity_created'", [hostedSignup.id])).rows;
  assert.deepEqual([signupEvent.synthetic, signupEvent.test], [true, true]);
});

test('claim identity is validated before the code, with claim wording and the request platform on invalid outcomes', async () => {
  const missing = await request('/invites/ZZZZZZZZZZZZ/claims', { platform: 'mobile', journeyId: randomUUID() }, undefined, randomUUID());
  assert.equal(missing.status, 401);
  assert.equal(missing.error.code, 'IDENTITY_REQUIRED');
  assert.match(missing.error.message, /claim/);
  const unknown = await request('/invites/ZZZZZZZZZZZZ/claims', { platform: 'mobile', journeyId: randomUUID() }, randomUUID(), randomUUID());
  assert.equal(unknown.status, 401);
  const host = (await identity()).id;
  const listing = await activity(host);
  const { code, id: inviteId } = (await share(listing.id, host)).data;
  const guest = (await identity()).id;
  const keyless = await request(`/invites/${code}/claims`, { platform: 'mobile', journeyId: randomUUID() }, guest);
  assert.equal(keyless.status, 400);
  const [outcome] = (await owner.query("SELECT platform,invite_id,activity_id,context FROM analytics_events WHERE context->>'requestId'=$1", [keyless.requestId])).rows;
  assert.deepEqual([outcome.platform, outcome.invite_id, outcome.activity_id, outcome.context.platformKnown, outcome.context.operation],
    ['mobile', inviteId, listing.id, true, 'claim_invite']);
  const directKeyless = await request(`/activities/${listing.id}/bookings`, { platform: 'mobile', journeyId: randomUUID() }, guest);
  const [direct] = (await owner.query("SELECT platform,context FROM analytics_events WHERE context->>'requestId'=$1", [directKeyless.requestId])).rows;
  assert.deepEqual([direct.platform, direct.context.platformKnown], ['mobile', true]);
});

test('started, completed, cancelled and expired links mean the same thing for preview, signup and claim', async () => {
  const host = (await identity()).id;
  const expectations = [
    ['started', "UPDATE activities SET starts_at=now() - interval '1 minute' WHERE id=$1", 409, 'ACTIVITY_STARTED'],
    ['completed', "UPDATE activities SET status='completed' WHERE id=$1", 409, 'ACTIVITY_STARTED'],
    ['cancelled', "UPDATE activities SET status='cancelled' WHERE id=$1", 409, 'ACTIVITY_UNAVAILABLE'],
  ] as const;
  for (const [scenario, sql, status, code] of expectations) {
    const listing = await activity(host);
    const { code: inviteCode } = (await share(listing.id, host)).data;
    const recovered = (await identity()).id;
    assert.equal((await claim(inviteCode, recovered)).status, 201);
    await owner.query(sql, [listing.id]);
    assert.equal((await request(`/invites/${inviteCode}`)).data.state, scenario === 'completed' ? 'started' : scenario);
    const signup = await request('/identities', { displayName: 'Late guest', journeyId: randomUUID(), platform: 'mobile', inviteCode });
    assert.deepEqual([signup.status, signup.error?.code], [status, code], scenario);
    const claimed = await claim(inviteCode, (await identity()).id);
    assert.deepEqual([claimed.status, claimed.error?.code], [status, code], scenario);
    // An existing member still recovers their seat whatever the link's state.
    assert.equal((await claim(inviteCode, recovered)).status, 200);
  }
});
