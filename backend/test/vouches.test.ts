import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { before, after, test } from 'node:test';
import pg from 'pg';
import { createApp } from '../src/app.js';
import type { InviteConfig } from '../src/experiments.js';
import { runMigrations } from '../src/migrations.js';

// Each run owns a new database; no demo data is removed by these checks.
const name = `velio_test_${randomUUID().replaceAll('-', '')}`;
const admin = new pg.Client({ connectionString: process.env.MIGRATION_DATABASE_URL });
let owner: pg.Pool;
let runtime: pg.Pool;
let server: ReturnType<ReturnType<typeof createApp>['listen']>;
let base: string;
async function start(invites: InviteConfig) {
  if (server) await new Promise<void>(resolve => server.close(() => resolve()));
  server = createApp({ invites, postgres: runtime, redis: { ping: async () => 'PONG' } }, 'http://localhost:5173', () => {}).listen(0, '127.0.0.1');
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
  await start({ version: 'vouches', treatmentPercent: 100, creationEnabled: true });
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
const contact = () => `guest-${randomUUID().slice(0, 8)}@example.com`;
async function activity(host: string, capacity = 3) {
  const result = await request('/activities', { title: 'Vouch test', description: 'Synthetic vouch scenario', meetingLocation: 'Test gate',
    startsAt: '2030-01-15T07:00:00Z', timezone: 'Africa/Lagos', capacity, priceMinor: 1500, currency: 'NGN' }, host);
  assert.equal(result.status, 201, JSON.stringify(result));
  return result.data;
}
function vouch(activityId: string, actor: string, recipientContact: unknown, journeyId?: string) {
  return request(`/activities/${activityId}/invites`, { rail: 'vouch', recipientContact, platform: 'web', ...(journeyId ? { journeyId } : {}) }, actor);
}
function book(activityId: string, actor: string, key = randomUUID()) {
  return request(`/activities/${activityId}/bookings`, { platform: 'web', journeyId: randomUUID() }, actor, key);
}
function claim(code: string, actor: string, key = randomUUID(), journeyId = randomUUID()) {
  return request(`/invites/${code}/claims`, { platform: 'mobile', journeyId }, actor, key);
}
async function reconcile(activityId: string, expected: number) {
  const state = (await owner.query('SELECT * FROM booking_reconciliation WHERE activity_id=$1', [activityId])).rows[0];
  assert.deepEqual([state.booking_count, state.counter_mismatch, state.oversold], [expected, false, false]);
}
async function redemptions(inviteId: string) {
  return (await owner.query('SELECT count(*)::int AS n FROM invite_redemptions WHERE invite_id=$1', [inviteId])).rows[0].n;
}

test('a host vouches for one normalized contact; the link expires within 24 hours and reserves no seat', async () => {
  const host = (await identity()).id;
  const listing = await activity(host);
  const created = await vouch(listing.id, host, '  Tunde@Example.COM ');
  assert.equal(created.status, 201, JSON.stringify(created));
  assert.match(created.data.code, /^[0-9A-HJKMNP-TV-Z]{12}$/);
  assert.equal(created.data.rail, 'vouch');
  assert.equal(created.data.inviterRole, 'host');
  assert.equal(created.data.recipientContact, 'tunde@example.com');
  assert.equal(Date.parse(created.data.expiresAt) - Date.parse(created.data.createdAt), 24 * 60 * 60 * 1000);
  assert.equal((await request(`/activities/${listing.id}`)).data.remainingSeats, 3);
  const phone = await vouch(listing.id, host, '+234 (803) 555-0101');
  assert.equal(phone.data.recipientContact, '+2348035550101');
});

test('vouch creation obeys the host/booker, assignment, kill-switch and capacity rules of public sharing', async () => {
  const hostContact = contact();
  const host = (await identity({ contact: hostContact })).id;
  const booker = (await identity()).id;
  const outsider = (await identity()).id;
  const listing = await activity(host, 2);
  assert.equal((await vouch(listing.id, outsider, contact())).error.code, 'INVITE_CREATION_UNAVAILABLE');
  assert.equal((await book(listing.id, booker)).status, 201);
  const booked = await vouch(listing.id, booker, contact());
  assert.equal(booked.status, 201);
  assert.equal(booked.data.inviterRole, 'booker');
  for (const invalid of [undefined, '', 'not a contact', '12345', 'a@b']) {
    assert.equal((await vouch(listing.id, host, invalid)).error.code, 'INVALID_REQUEST', String(invalid));
  }
  assert.equal((await request(`/activities/${listing.id}/invites`, { rail: 'public', recipientContact: contact(), platform: 'web' }, host)).status, 400);
  assert.equal((await vouch(listing.id, host, hostContact.toUpperCase())).error.code, 'SELF_INVITE');
  await start({ version: 'vouches-control', treatmentPercent: 0, creationEnabled: true });
  try {
    const control = await activity(host);
    assert.equal((await vouch(control.id, host, contact())).error.code, 'INVITE_CREATION_UNAVAILABLE');
    await start({ version: 'vouches', treatmentPercent: 100, creationEnabled: false });
    assert.equal((await vouch(listing.id, host, contact())).error.code, 'INVITE_CREATION_UNAVAILABLE');
  } finally { await start({ version: 'vouches', treatmentPercent: 100, creationEnabled: true }); }
  assert.equal((await book(listing.id, (await identity()).id)).status, 201);
  assert.equal((await vouch(listing.id, host, contact())).error.code, 'SOLD_OUT');
});

test('only the intended contact redeems a vouch, once; wrong recipients consume neither a seat nor the vouch', async () => {
  const host = (await identity()).id;
  const listing = await activity(host, 2);
  const recipientContact = contact();
  const { code, id: inviteId } = (await vouch(listing.id, host, recipientContact)).data;
  for (const wrong of [(await identity()).id, (await identity({ contact: contact() })).id]) {
    const rejected = await claim(code, wrong);
    assert.deepEqual([rejected.status, rejected.error.code], [403, 'RECIPIENT_MISMATCH']);
    assert.equal(rejected.error.message.includes(recipientContact), false, 'Errors must not disclose the intended contact');
  }
  await reconcile(listing.id, 0);
  assert.equal(await redemptions(inviteId), 0);
  const recipient = (await identity({ contact: recipientContact.toUpperCase() })).id;
  const key = randomUUID();
  const claimed = await claim(code, recipient, key);
  assert.equal(claimed.status, 201, JSON.stringify(claimed));
  assert.deepEqual([claimed.data.redemption.rail, claimed.data.redemption.inviteId], ['vouch', inviteId]);
  // Fill the last seat: the recipient still reopens the same confirmation by key or by membership.
  assert.equal((await book(listing.id, (await identity()).id)).status, 201);
  for (const retry of [await claim(code, recipient, key), await claim(code, recipient)]) {
    assert.equal(retry.status, 200);
    assert.equal(retry.data.replayed, true);
    assert.equal(retry.data.booking.id, claimed.data.booking.id);
    assert.equal(retry.data.redemption.id, claimed.data.redemption.id);
  }
  // Anyone else presenting the consumed code learns only that it is recipient-bound.
  assert.equal((await claim(code, (await identity({ contact: contact() })).id)).error.code, 'RECIPIENT_MISMATCH');
  assert.equal(await redemptions(inviteId), 1);
  await reconcile(listing.id, 2);
});

test('racing recipient retries, wrong recipients and direct bookings commit exactly one vouch redemption', async () => {
  const host = (await identity()).id;
  // Room for the recipient and every direct booker, so the race isolates recipient and redemption checks.
  const listing = await activity(host, 7);
  const recipientContact = contact();
  const { code, id: inviteId } = (await vouch(listing.id, host, recipientContact)).data;
  const recipient = (await identity({ contact: recipientContact })).id;
  const others = await Promise.all(Array.from({ length: 12 }, () => identity({ contact: contact() })));
  const key = randomUUID();
  const lock = await owner.connect();
  await lock.query('BEGIN');
  await lock.query('SELECT id FROM activities WHERE id=$1 FOR UPDATE', [listing.id]);
  let requests: Promise<Awaited<ReturnType<typeof request>>>[];
  try {
    requests = [
      ...Array.from({ length: 4 }, () => claim(code, recipient, key)), ...Array.from({ length: 4 }, () => claim(code, recipient)),
      ...others.slice(0, 6).map(other => claim(code, other.id)), ...others.slice(6).map(other => book(listing.id, other.id)),
    ];
    let overlap = 0;
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && overlap < 10) {
      overlap = (await owner.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=$1 AND wait_event_type='Lock'", [name])).rows[0].n;
      if (overlap < 10) await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.ok(overlap >= 10, `Expected overlapping transactions, saw ${overlap}`);
  } finally { await lock.query('ROLLBACK'); lock.release(); }
  const outcomes = await Promise.all(requests);
  const recipientOutcomes = outcomes.slice(0, 8);
  const committed = recipientOutcomes.filter(result => result.status === 201);
  assert.equal(committed.length, 1, JSON.stringify(recipientOutcomes));
  assert.ok(recipientOutcomes.every(result => result.data?.booking.id === committed[0].data.booking.id), JSON.stringify(recipientOutcomes));
  assert.equal(new Set(recipientOutcomes.map(result => result.data.redemption.id)).size, 1);
  assert.ok(outcomes.slice(8, 14).every(result => result.error?.code === 'RECIPIENT_MISMATCH'), JSON.stringify(outcomes.slice(8, 14)));
  assert.ok(outcomes.slice(14).every(result => result.status === 201));
  assert.equal(await redemptions(inviteId), 1);
  await reconcile(listing.id, 7);
});

test('a failure before commit rolls back the vouch redemption with the seat, and the same key then succeeds', async () => {
  const host = (await identity()).id;
  const listing = await activity(host, 2);
  const recipientContact = contact();
  const { code, id: inviteId } = (await vouch(listing.id, host, recipientContact)).data;
  const recipient = (await identity({ contact: recipientContact })).id;
  const key = randomUUID();
  await owner.query(`CREATE FUNCTION fail_test_vouch() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.booking_id IN (SELECT id FROM bookings WHERE activity_id='${listing.id}') THEN RAISE EXCEPTION 'Injected outbox failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER fail_test_vouch BEFORE INSERT ON outbox_events FOR EACH ROW EXECUTE FUNCTION fail_test_vouch()`);
  try {
    const failed = await claim(code, recipient, key);
    assert.deepEqual([failed.status, failed.error.retryable], [500, true]);
    await reconcile(listing.id, 0);
    assert.equal(await redemptions(inviteId), 0);
  } finally { await owner.query('DROP TRIGGER fail_test_vouch ON outbox_events; DROP FUNCTION fail_test_vouch()'); }
  assert.equal((await claim(code, recipient, key)).status, 201);
  assert.equal(await redemptions(inviteId), 1);
  await reconcile(listing.id, 1);
});

test('expiry is judged at transaction time and an expired vouch consumes nothing', async () => {
  const host = (await identity()).id;
  const listing = await activity(host, 3);
  const recipientContact = contact();
  const { code, id } = (await vouch(listing.id, host, recipientContact)).data;
  const recipient = (await identity({ contact: recipientContact })).id;
  await owner.query(`ALTER TABLE invites DISABLE TRIGGER invites_append_only;
    UPDATE invites SET created_at=clock_timestamp() - interval '23 hours 59 minutes', expires_at=clock_timestamp() + interval '500 milliseconds' WHERE id='${id}';
    ALTER TABLE invites ENABLE TRIGGER invites_append_only`);
  assert.equal((await request(`/invites/${code}`)).data.state, 'valid');
  await new Promise(resolve => setTimeout(resolve, 600));
  assert.deepEqual([(await claim(code, recipient)).error.code, (await request(`/invites/${code}`)).data.state], ['INVITE_EXPIRED', 'expired']);
  assert.equal(await redemptions(id), 0);
  await reconcile(listing.id, 0);
});

test('an existing direct booking is recovered through a vouch without consuming it or changing attribution', async () => {
  const host = (await identity()).id;
  const listing = await activity(host, 2);
  const recipientContact = contact();
  const recipient = (await identity({ contact: recipientContact })).id;
  const direct = await book(listing.id, recipient);
  const { code, id } = (await vouch(listing.id, host, recipientContact)).data;
  const recovered = await claim(code, recipient);
  assert.deepEqual([recovered.status, recovered.data.booking.id, recovered.data.redemption], [200, direct.data.booking.id, null]);
  assert.equal(await redemptions(id), 0);
  await reconcile(listing.id, 1);
});

test('signup through a vouch requires the intended contact and freezes vouch acquisition', async () => {
  const host = (await identity()).id;
  const listing = await activity(host);
  const recipientContact = contact();
  const { code, id } = (await vouch(listing.id, host, recipientContact)).data;
  for (const extra of [{}, { contact: contact() }]) {
    const wrong = await request('/identities', { displayName: 'Wrong contact', journeyId: randomUUID(), platform: 'mobile', inviteCode: code, ...extra });
    assert.deepEqual([wrong.status, wrong.error.code], [403, 'RECIPIENT_MISMATCH']);
  }
  const guest = await identity({ inviteCode: code, contact: recipientContact });
  assert.deepEqual([guest.generation, guest.acquisitionParentId, guest.acquisitionRail], [1, host, 'vouch']);
  assert.equal('contact' in guest, false, 'Identity responses never expose contacts');
  const duplicate = await request('/identities', { displayName: 'Same contact', journeyId: randomUUID(), platform: 'mobile', contact: recipientContact });
  assert.deepEqual([duplicate.status, duplicate.error.code], [409, 'CONTACT_IN_USE']);
  assert.equal((await claim(code, guest.id)).data.redemption.inviteeGeneration, 1);
  const attribution = (await owner.query('SELECT rail,invite_id FROM signup_attribution WHERE user_id=$1', [guest.id])).rows[0];
  assert.deepEqual(attribution, { rail: 'vouch', invite_id: id });
});

test('public previews and analytics never carry the intended contact, while vouch rail and generation are server-derived', async () => {
  const host = await identity({ displayName: 'Amara vouch host' });
  const listing = await activity(host.id, 2);
  const recipientContact = contact();
  const journeyId = randomUUID();
  const { code, id } = (await vouch(listing.id, host.id, recipientContact, journeyId)).data;
  const preview = await request(`/invites/${code}`);
  assert.deepEqual([preview.status, preview.data.rail, preview.data.trust, preview.data.state], [200, 'vouch', 'vouch', 'valid']);
  assert.equal(JSON.stringify(preview).includes(recipientContact), false);
  const open = { id: randomUUID(), schemaVersion: 1, name: 'invite_opened', occurredAt: new Date().toISOString(), source: 'client', platform: 'mobile',
    journeyId, inviteCode: code, displayedState: 'valid' };
  assert.equal((await request('/events', open)).data.accepted, true);
  assert.equal((await request('/events', open)).data.accepted, false);
  const guest = await identity({ inviteCode: code, contact: recipientContact }, journeyId);
  await claim(code, (await identity({ contact: contact() })).id, randomUUID(), journeyId);
  assert.equal((await claim(code, guest.id, randomUUID(), journeyId)).status, 201);
  const events = (await owner.query('SELECT name,context FROM analytics_events WHERE invite_id=$1', [id])).rows;
  for (const name of ['invite_created', 'invite_opened', 'identity_created', 'invite_claim_attempted', 'booking_failed', 'spot_claimed']) {
    const event = events.find(row => row.name === name);
    assert.ok(event, `${name} missing`);
    assert.equal(event.context.rail, 'vouch', name);
  }
  assert.equal(events.find(row => row.name === 'booking_failed').context.code, 'RECIPIENT_MISMATCH');
  assert.equal(events.find(row => row.name === 'spot_claimed').context.generation, 1);
  assert.equal(JSON.stringify(events).includes(recipientContact), false);
});

test('database guards refuse wrong-recipient redemptions, second vouch redemptions and recipient rewrites', async () => {
  const host = (await identity()).id;
  const listing = await activity(host, 3);
  const recipientContact = contact();
  const invite = (await vouch(listing.id, host, recipientContact)).data;
  const recipient = (await identity({ contact: recipientContact })).id;
  const claimed = (await claim(invite.code, recipient)).data;
  const other = (await identity({ contact: contact() })).id;
  const otherBooking = (await book(listing.id, other)).data.booking;
  await assert.rejects(runtime.query(`INSERT INTO invite_redemptions (id,invite_id,activity_id,inviter_id,rail,invitee_id,invitee_generation,booking_id)
    VALUES ($1,$2,$3,$4,'vouch',$5,0,$6)`, [randomUUID(), invite.id, listing.id, host, other, otherBooking.id]), /different contact/);
  await assert.rejects(owner.query(`INSERT INTO invite_redemptions (id,invite_id,activity_id,inviter_id,rail,invitee_id,invitee_generation,booking_id)
    VALUES ($1,$2,$3,$4,'vouch',$5,0,$6)`, [randomUUID(), invite.id, listing.id, host, recipient, otherBooking.id]), /foreign key|unique|one_vouch/);
  await assert.rejects(runtime.query('UPDATE invites SET recipient_contact=$1 WHERE id=$2', [contact(), invite.id]), /permission denied/);
  await assert.rejects(owner.query('UPDATE invites SET recipient_contact=$1 WHERE id=$2', [contact(), invite.id]), /append-only/);
  await assert.rejects(runtime.query('UPDATE users SET contact=$1 WHERE id=$2', [contact(), recipient]), /permission denied/);
  await assert.rejects(runtime.query(`INSERT INTO invites (id,code,activity_id,plan_id,inviter_id,inviter_role,rail,inviter_generation,inviter_root_id,invitee_generation,expires_at)
    VALUES ($1,'ABCDEFGHJKMN',$2,$3,$4,'host','vouch',0,$4,1,now() + interval '1 hour')`, [randomUUID(), listing.id, listing.planId, host]), /invites_vouch_recipient/);
  await assert.rejects(runtime.query(`INSERT INTO users (id,display_name,contact,generation,acquisition_parent_id,acquisition_root_id,acquisition_invite_id,acquisition_rail)
    VALUES ($1,'Forged vouch child',$2,1,$3,$3,$4,'vouch')`, [randomUUID(), contact(), host, invite.id]), /different contact/);
  assert.equal(claimed.redemption.rail, 'vouch');
});
