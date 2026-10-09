import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { before, after, test } from 'node:test';
import pg from 'pg';
import { createApp } from '../src/app.js';
import { loadInviteConfig } from '../src/experiments.js';
import { runMigrations } from '../src/migrations.js';

// Product-metric fixtures live directly in the database with fixed historical timestamps,
// like the labelled seeds: the point is to verify the calculations, not the write paths.
const name = `velio_metrics_${randomUUID().replaceAll('-', '')}`;
const admin = new pg.Client({ connectionString: process.env.MIGRATION_DATABASE_URL });
let owner: pg.Pool;
let runtime: pg.Pool;
let base: string;
let server: import('http').Server;

const from = '2026-10-01T00:00:00Z';
const to = '2026-10-08T00:00:00Z';

before(async () => {
  assert.ok(process.env.MIGRATION_DATABASE_URL && process.env.DATABASE_URL, 'Run npm run setup and npm run infra:up first');
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  function url(value: string) { const parsed = new URL(value); parsed.pathname = `/${name}`; return parsed.href; }
  await runMigrations(new pg.Client({ connectionString: url(process.env.MIGRATION_DATABASE_URL!) }),
    new URL('../migrations/', import.meta.url).pathname);
  owner = new pg.Pool({ connectionString: url(process.env.MIGRATION_DATABASE_URL!) });
  runtime = new pg.Pool({ connectionString: url(process.env.DATABASE_URL!) });
  await fixtures();
  const app = createApp({ invites: loadInviteConfig({}), postgres: runtime, redis: { ping: async () => 'PONG' } },
    'http://localhost:5173');
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

// Hand-calculated labelled scenarios from PLANS.md §4.2. Fixed UUID prefixes keep entities
// distinguishable: users 1111…, activities 2222…, invites 3333…, bookings 4444…, journeys 5555….
const host1 = '11111111-0000-4000-8000-000000000001';
const actR = '22222222-0000-4000-8000-000000000001';

async function fixtures() {
  await organicUser(host1, '2026-09-20T09:00:00Z', 'Metrics host');
  await activity(actR, host1, '2030-01-01T09:00:00Z', '2026-09-20T10:00:00Z');
  // Reliability intents: rA retries an eligible technical failure into a commit; rB/rC fail
  // eligible/unknown; rD sold out and rE invalid are excluded from reliability; rF replays a
  // committed result; rG commits exactly at the window start; rH commits exactly at the end.
  const rA = '11111111-0000-4000-8000-000000000011', rB = '11111111-0000-4000-8000-000000000012',
    rC = '11111111-0000-4000-8000-000000000013', rD = '11111111-0000-4000-8000-000000000014',
    rE = '11111111-0000-4000-8000-000000000015', rF = '11111111-0000-4000-8000-000000000016',
    rG = '11111111-0000-4000-8000-000000000017', rH = '11111111-0000-4000-8000-000000000018';
  for (const suffix of ['11', '12', '13', '14', '15', '16', '17', '18']) {
    await organicUser(`11111111-0000-4000-8000-0000000000${suffix}`, '2026-09-25T09:00:00Z', `Reliability actor ${suffix}`);
  }
  await recordEvents([
    { id: randomUUID(), name: 'booking_attempted', occurredAt: '2026-10-02T09:59:00Z', actorId: rA, activityId: actR, context: { operation: 'book_activity', eligibility: 'unknown' } },
    outcome(rA, 'technical_error', 'eligible', '2026-10-02T09:59:30Z'),
    { id: randomUUID(), name: 'booking_attempted', occurredAt: '2026-10-02T10:00:00Z', actorId: rA, activityId: actR, context: { operation: 'book_activity', eligibility: 'unknown' } },
    outcome(rA, 'committed', 'eligible', '2026-10-02T10:00:30Z'),
    outcome(rB, 'technical_error', 'eligible', '2026-10-03T10:00:00Z'),
    outcome(rC, 'technical_error', 'unknown', '2026-10-03T11:00:00Z'),
    outcome(rD, 'sold_out', 'sold_out', '2026-10-03T12:00:00Z'),
    outcome(rE, 'invalid', 'ineligible', '2026-10-03T13:00:00Z'),
    outcome(rF, 'replay', 'replay', '2026-10-04T10:00:00Z'),
    outcome(rG, 'committed', 'eligible', from),
    outcome(rH, 'committed', 'eligible', to),
  ]);
  // Integrity fixture: an owner write leaves two booking rows on a one-seat activity with a
  // zero counter. Its users book before the window, so windowed metrics never see the damage.
  const act9 = '22222222-0000-4000-8000-000000000090';
  await activity(act9, host1, '2030-01-01T09:00:00Z', '2026-09-20T10:00:00Z', 1);
  for (const suffix of ['91', '92']) {
    await organicUser(`11111111-0000-4000-8000-0000000000${suffix}`, '2026-09-21T09:00:00Z', `Integrity actor ${suffix}`);
    await booking(randomUUID(), act9, `11111111-0000-4000-8000-0000000000${suffix}`, '2026-09-22T09:00:00Z');
  }
  await productFixtures();
}

// Product-metric cast. The same users flow through several funnels (a K-acquired guest also
// becomes a booker; an open journey's signup is also an acquisition), so every expectation
// below is calculated once against this whole universe, not per scenario.
const act0 = '22222222-0000-4000-8000-000000000000', act1 = '22222222-0000-4000-8000-000000000002',
  act2 = '22222222-0000-4000-8000-000000000003', act3 = '22222222-0000-4000-8000-000000000004',
  act4 = '22222222-0000-4000-8000-000000000005';
const booker0 = '11111111-0000-4000-8000-000000000002';
function user(suffix: string) { return `11111111-0000-4000-8000-0000000000${suffix}`; }
function journey(suffix: string) { return `55555555-0000-4000-8000-0000000000${suffix}`; }
function inviteId(suffix: string) { return `33333333-0000-4000-8000-0000000000${suffix}`; }
function inviteCodeText(suffix: string) { return `AAAA00000${suffix.padStart(2, '0').slice(-3)}X`; }

async function productFixtures() {
  for (const [id, created] of [
    [act0, '2026-09-26T10:00:00Z'], [act1, '2026-09-30T10:00:00Z'], [act2, '2026-09-30T10:00:00Z'],
    [act3, '2026-09-30T10:00:00Z'], [act4, '2026-09-30T10:00:00Z'],
  ] as const) {
    await activity(id, host1, id === act4 ? '2026-10-05T12:00:00Z' : '2030-01-01T09:00:00Z', created);
  }
  // Cohort fixture: booker0 booked before the window and never invites.
  await organicUser(booker0, '2026-09-25T09:00:00Z', 'Cohort booker');
  await booking(randomUUID(), act0, booker0, '2026-09-28T10:00:00Z');

  // Booker-to-inviter: booker1 invites 23h after a first booking; booker2 at 25h (too late);
  // booker3's window is not yet mature; booker4 never invites; booker5's first window booking
  // follows an earlier pre-window booking; booker6 invites for the wrong (second) activity.
  for (const suffix of ['21', '22', '23', '24', '25', '26']) {
    await organicUser(user(suffix), '2026-09-25T09:00:00Z', `Booker ${suffix}`);
  }
  await booking(randomUUID(), act1, user('21'), '2026-10-01T10:00:00Z');
  await booking(randomUUID(), act1, user('22'), '2026-10-02T10:00:00Z');
  await booking(randomUUID(), act1, user('23'), '2026-10-07T23:00:00Z');
  await booking(randomUUID(), act1, user('24'), '2026-10-03T10:00:00Z');
  await booking(randomUUID(), act0, user('25'), '2026-09-28T11:00:00Z');
  await booking(randomUUID(), act1, user('25'), '2026-10-04T10:00:00Z');
  await booking(randomUUID(), act1, user('26'), '2026-10-05T10:00:00Z');
  await booking(randomUUID(), act2, user('26'), '2026-10-05T12:00:00Z');
  await invite(inviteId('21'), inviteCodeText('21'), act1, user('21'), 'booker', 'public', '2026-10-02T09:00:00Z', '2026-10-03T09:00:00Z', 0, user('21'));
  await invite(inviteId('22'), inviteCodeText('22'), act1, user('22'), 'booker', 'public', '2026-10-03T11:00:00Z', '2026-10-04T11:00:00Z', 0, user('22'));
  await invite(inviteId('23'), inviteCodeText('23'), act1, user('23'), 'booker', 'public', '2026-10-07T23:30:00Z', '2026-10-08T23:30:00Z', 0, user('23'));
  await invite(inviteId('25'), inviteCodeText('25'), act1, user('25'), 'booker', 'vouch', '2026-10-04T20:00:00Z', '2026-10-05T08:00:00Z', 0, user('25'), null, 'bookerfive@example.com');
  await invite(inviteId('26'), inviteCodeText('26'), act2, user('26'), 'booker', 'public', '2026-10-05T13:00:00Z', '2026-10-06T13:00:00Z', 0, user('26'));
  // host1 never books: a host invite is the separate creator segment.
  await invite(inviteId('27'), inviteCodeText('27'), act1, host1, 'host', 'public', '2026-10-02T08:00:00Z', '2026-10-03T08:00:00Z', 0, host1);

  // K-factor: host1 (cohort) acquires kGuestV (vouch, activated) and kGuestP (public, never
  // books); booker1 is outside the cohort, so kGuestX stays out of direct K; kGuestV's own
  // acquisition kDeep is a generation-2 descendant for a later cohort.
  await invite(inviteId('28'), inviteCodeText('28'), act2, host1, 'host', 'vouch', '2026-10-03T09:00:00Z', '2026-10-04T09:00:00Z', 0, host1, null, 'kguestv@example.com');
  await invite(inviteId('29'), inviteCodeText('29'), act2, host1, 'host', 'public', '2026-10-04T09:00:00Z', '2026-10-05T09:00:00Z', 0, host1);
  await invite(inviteId('30'), inviteCodeText('30'), act2, user('21'), 'booker', 'public', '2026-10-06T09:00:00Z', '2026-10-07T09:00:00Z', 0, user('21'));
  await invitedUser(user('31'), 'K guest vouch', '2026-10-03T10:00:00Z', inviteId('28'), host1, host1, 1, 'vouch', 'kguestv@example.com');
  await invite(inviteId('31'), inviteCodeText('31'), act2, user('31'), 'booker', 'public', '2026-10-06T11:30:00Z', '2026-10-07T11:30:00Z', 1, host1, host1);
  await invitedUser(user('32'), 'K guest public', '2026-10-04T10:00:00Z', inviteId('29'), host1, host1, 1, 'public');
  await invitedUser(user('33'), 'K guest outside cohort', '2026-10-06T10:00:00Z', inviteId('30'), user('21'), user('21'), 1, 'public');
  await invitedUser(user('34'), 'K generation two', '2026-10-06T12:00:00Z', inviteId('31'), user('31'), host1, 2, 'public');
  await booking(randomUUID(), act1, user('31'), '2026-10-03T11:00:00Z');
  await booking(randomUUID(), act1, user('33'), '2026-10-06T11:00:00Z');

  // Open-to-claim journeys. Repeated opens of one (invite, journey) deduplicate; deadlines are
  // the earlier of 24h and activity start (J9 hits exactly 24h; J10 claims past the start).
  await invite(inviteId('32'), inviteCodeText('32'), act3, host1, 'host', 'public', '2026-10-01T09:00:00Z', '2026-10-02T09:00:00Z', 0, host1);
  await invite(inviteId('33'), inviteCodeText('33'), act3, host1, 'host', 'public', '2026-10-03T08:00:00Z', '2026-10-04T08:00:00Z', 0, host1);
  await invite(inviteId('34'), inviteCodeText('34'), act3, host1, 'host', 'vouch', '2026-10-04T07:00:00Z', '2026-10-05T07:00:00Z', 0, host1, null, 'openguestvouch@example.com');
  await invite(inviteId('35'), inviteCodeText('35'), act4, host1, 'host', 'public', '2026-10-04T18:00:00Z', '2026-10-05T12:00:00Z', 0, host1);
  await invitedUser(user('51'), 'Open guest one', '2026-10-02T08:45:00Z', inviteId('32'), host1, host1, 1, 'public');
  await invitedUser(user('52'), 'Open guest two', '2026-10-03T09:45:00Z', inviteId('33'), host1, host1, 1, 'public');
  await invitedUser(user('55'), 'Open guest full', '2026-10-03T11:30:00Z', inviteId('33'), host1, host1, 1, 'public');
  await invitedUser(user('57'), 'Open guest vouch', '2026-10-04T10:30:00Z', inviteId('34'), host1, host1, 1, 'vouch', 'openguestvouch@example.com');
  await invitedUser(user('59'), 'Open guest boundary', '2026-10-05T08:30:00Z', inviteId('33'), host1, host1, 1, 'public');
  await invitedUser(user('50'), 'Open guest started', '2026-10-05T12:00:00Z', inviteId('35'), host1, host1, 1, 'public');
  const open = (suffix: string, inviteSuffix: string, at: string, platformText: string, displayed: string, rail: string, recovery = false, actorSuffix?: string) => ({
    id: randomUUID(), name: 'invite_opened', occurredAt: at, source: 'client', platform: platformText,
    journeyId: journey(suffix), inviteId: inviteId(inviteSuffix), actorId: actorSuffix ? user(actorSuffix) : null,
    activityId: null, context: { rail, inviterRole: 'host', inviterGeneration: 0, displayedState: displayed,
      stateAtReceipt: displayed, recovery, ...(actorSuffix ? { generation: 0 } : {}) },
  });
  const bookingIds = new Map<string, string>();
  for (const suffix of ['51', '52', '55', '57', '59', '50']) bookingIds.set(suffix, randomUUID());
  await booking(bookingIds.get('51')!, act3, user('51'), '2026-10-02T08:50:00Z');
  await booking(bookingIds.get('52')!, act3, user('52'), '2026-10-03T11:00:00Z');
  await booking(bookingIds.get('55')!, act3, user('55'), '2026-10-03T12:00:00Z');
  await booking(bookingIds.get('57')!, act3, user('57'), '2026-10-05T06:00:00Z');
  await booking(bookingIds.get('59')!, act3, user('59'), '2026-10-06T08:00:00Z');
  await booking(bookingIds.get('50')!, act4, user('50'), '2026-10-05T12:30:00Z');
  await redemption(randomUUID(), inviteId('32'), act3, host1, user('51'), bookingIds.get('51')!, '2026-10-02T08:50:00Z');
  await redemption(randomUUID(), inviteId('33'), act3, host1, user('52'), bookingIds.get('52')!, '2026-10-03T11:00:00Z');
  await redemption(randomUUID(), inviteId('33'), act3, host1, user('55'), bookingIds.get('55')!, '2026-10-03T12:00:00Z');
  await redemption(randomUUID(), inviteId('34'), act3, host1, user('57'), bookingIds.get('57')!, '2026-10-05T06:00:00Z');
  await redemption(randomUUID(), inviteId('33'), act3, host1, user('59'), bookingIds.get('59')!, '2026-10-06T08:00:00Z');
  await redemption(randomUUID(), inviteId('35'), act4, host1, user('50'), bookingIds.get('50')!, '2026-10-05T12:30:00Z');
  const spotClaimed = (journeySuffix: string, inviteSuffix: string, at: string, actorSuffix: string, bookingSuffix: string, rail: string) => ({
    id: randomUUID(), name: 'spot_claimed', occurredAt: at, journeyId: journey(journeySuffix), inviteId: inviteId(inviteSuffix),
    actorId: user(actorSuffix), activityId: null, bookingId: bookingIds.get(bookingSuffix),
    context: { operation: 'claim_invite', rail, generation: 1, inviteeGeneration: 1, outcome: 'committed' },
  });
  await recordEvents([
    open('01', '32', '2026-10-02T08:00:00Z', 'mobile', 'valid', 'public'),
    open('01', '32', '2026-10-02T08:30:00Z', 'mobile', 'valid', 'public'),
    spotClaimed('01', '32', '2026-10-02T08:50:00Z', '51', '51', 'public'),
    open('02', '33', '2026-10-03T09:00:00Z', 'mobile', 'valid', 'public'),
    spotClaimed('02', '33', '2026-10-03T11:00:00Z', '52', '52', 'public'),
    open('03', '33', '2026-10-03T10:00:00Z', 'web', 'valid', 'public'),
    open('04', '33', '2026-10-07T23:30:00Z', 'web', 'valid', 'public'),
    open('05', '33', '2026-10-03T11:00:00Z', 'mobile', 'full', 'public'),
    spotClaimed('05', '33', '2026-10-03T12:00:00Z', '55', '55', 'public'),
    open('06', '33', '2026-10-04T09:00:00Z', 'web', 'valid', 'public', true, '52'),
    open('07', '34', '2026-10-04T10:00:00Z', 'web', 'valid', 'vouch'),
    spotClaimed('07', '34', '2026-10-05T06:00:00Z', '57', '57', 'vouch'),
    open('09', '33', '2026-10-05T08:00:00Z', 'web', 'valid', 'public'),
    spotClaimed('09', '33', '2026-10-06T08:00:00Z', '59', '59', 'public'),
    open('10', '35', '2026-10-04T20:00:00Z', 'mobile', 'valid', 'public'),
    spotClaimed('10', '35', '2026-10-05T12:30:00Z', '50', '50', 'public'),
    open('11', '33', '2026-10-05T09:00:00Z', 'web', 'valid', 'public', false, '22'),
  ]);

  // Holdout: four assigned activities, none exposed to anyone. act5 forms a plan (3
  // participants), act6 does not (1), act7 forms (2), act8 stays empty.
  const act5 = '22222222-0000-4000-8000-000000000006', act6 = '22222222-0000-4000-8000-000000000007',
    act7 = '22222222-0000-4000-8000-000000000008', act8 = '22222222-0000-4000-8000-000000000009';
  for (const [id, allocation] of [[act5, 100], [act6, 100], [act7, 0], [act8, 0]] as const) {
    await activity(id, host1, '2030-01-01T09:00:00Z', '2026-10-01T12:00:00Z', 20, 'metrics-holdout', allocation);
  }
  for (const suffix of ['41', '42', '43', '44', '45', '46']) {
    await organicUser(user(suffix), '2026-09-25T09:00:00Z', `Holdout participant ${suffix}`);
  }
  for (const [suffix, target] of [['41', act5], ['42', act5], ['43', act5], ['44', act6], ['45', act7], ['46', act7]] as const) {
    await booking(randomUUID(), target, user(suffix), '2026-10-02T10:00:00Z');
  }
  // Fixture bookings bypass the counter-updating transaction, so align stored counts with
  // rows everywhere except the deliberate act9 violation.
  await owner.query(`UPDATE activities a SET confirmed_count = (SELECT count(*) FROM bookings b WHERE b.activity_id=a.id)
    WHERE id <> '22222222-0000-4000-8000-000000000090'`);
}


after(async () => {
  if (server) await new Promise<void>(resolve => server.close(() => resolve()));
  await runtime?.end(); await owner?.end();
  await admin.query(`DROP DATABASE IF EXISTS ${name}`);
  await admin.end();
});

async function summary(query = `?from=${from}&to=${to}&includeTest=true`) {
  const response = await fetch(`${base}/api/metrics/summary${query}`);
  return { status: response.status, ...(await response.json()) };
}
async function product(query = `?from=${from}&to=${to}&includeTest=true`) {
  const response = await fetch(`${base}/api/metrics/product${query}`);
  return { status: response.status, ...(await response.json()) };
}

// Every fixture is synthetic so product metrics stay empty unless includeTest=true.
async function organicUser(id: string, createdAt: string, name: string, contact: string | null = null) {
  await owner.query(`INSERT INTO users (id,display_name,contact,generation,acquisition_root_id,synthetic,created_at)
    VALUES ($1,$2,$3,0,$1,true,$4) ON CONFLICT (id) DO NOTHING`, [id, name, contact, createdAt]);
  await owner.query(`INSERT INTO signup_attribution (user_id,generation,root_id,created_at)
    VALUES ($1,0,$1,$2) ON CONFLICT (user_id) DO NOTHING`, [id, createdAt]);
}
async function invitedUser(id: string, name: string, createdAt: string, inviteIdText: string, inviterId: string, inviterRootId: string, generation: number, rail: string, contact: string | null = null) {
  await owner.query(`INSERT INTO users (id,display_name,contact,generation,acquisition_parent_id,acquisition_root_id,acquisition_invite_id,acquisition_rail,synthetic,created_at)
    VALUES ($1,$2,$9,$3,$4,$5,$6,$7,true,$8) ON CONFLICT (id) DO NOTHING`,
    [id, name, generation, inviterId, inviterRootId, inviteIdText, rail, createdAt, contact]);
  await owner.query(`INSERT INTO signup_attribution (user_id,generation,parent_id,root_id,invite_id,rail,created_at)
    VALUES ($1,$3,$4,$5,$6,$7,$2) ON CONFLICT (user_id) DO NOTHING`,
    [id, createdAt, generation, inviterId, inviterRootId, inviteIdText, rail]);
}
async function activity(id: string, hostId: string, startsAt: string, createdAt: string, capacity = 20, version = 'misc', allocation?: number, confirmed = 0) {
  // Assignment is a deferred FK on activities (migration 006), so both writes share a transaction.
  const client = await owner.connect();
  try {
    await client.query('BEGIN');
    await client.query(`INSERT INTO activities (id,host_id,title,description,meeting_location,starts_at,timezone,capacity,confirmed_count,price_minor,currency,created_at)
      VALUES ($1,$2,'Metrics fixture','Labelled fixture activity','Fixture gate',$3,'UTC',$4,$5,0,'NGN',$6)`, [id, hostId, startsAt, capacity, confirmed, createdAt]);
    await client.query('SELECT assign_invite_experiment($1,$2,$3)', [id, version, allocation ?? 50]);
    // Assignment timestamps default to now(); fixtures keep their historical cohort windows.
    await client.query('UPDATE experiment_assignments SET assigned_at=$3 WHERE activity_id=$1 AND version=$2', [id, version, createdAt]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
async function invite(id: string, code: string, activityId: string, inviterId: string, role: 'host' | 'booker', rail: 'vouch' | 'public',
  createdAt: string, expiresAt: string, inviterGeneration: number, inviterRootId: string, inviterParentId: string | null = null,
  recipientContact: string | null = null) {
  const plan = (await owner.query('SELECT id FROM plans WHERE activity_id=$1', [activityId])).rows[0].id;
  await owner.query(`INSERT INTO invites (id,code,activity_id,plan_id,inviter_id,inviter_role,rail,recipient_contact,inviter_generation,inviter_parent_id,inviter_root_id,invitee_generation,created_at,expires_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$14,$8,$9,$10,$11,$12,$13)`,
    [id, code, activityId, plan, inviterId, role, rail, inviterGeneration, inviterParentId, inviterRootId, inviterGeneration + 1, createdAt, expiresAt, recipientContact]);
}
async function booking(id: string, activityId: string, userId: string, confirmedAt: string) {
  const plan = (await owner.query('SELECT id FROM plans WHERE activity_id=$1', [activityId])).rows[0].id;
  await owner.query(`INSERT INTO bookings (id,activity_id,plan_id,user_id,price_minor,currency,confirmed_at)
    VALUES ($1,$2,$3,$4,0,'NGN',$5)`, [id, activityId, plan, userId, confirmedAt]);
}
async function redemption(id: string, inviteId: string, activityId: string, inviterId: string, inviteeId: string, bookingId: string, createdAt: string) {
  await owner.query(`INSERT INTO invite_redemptions (id,invite_id,activity_id,inviter_id,rail,invitee_id,invitee_generation,booking_id,created_at)
    SELECT $1,$2,$3,$4,i.rail,$5,u.generation,$6,$7 FROM invites i JOIN users u ON u.id=$5 WHERE i.id=$2`,
    [id, inviteId, activityId, inviterId, inviteeId, bookingId, createdAt]);
}
interface EventFixture { id: string; name: string; occurredAt: string; source?: string; platform?: string; actorId?: string | null; journeyId?: string | null;
  activityId?: string | null; bookingId?: string | null; inviteId?: string | null; context?: object }
async function recordEvents(events: EventFixture[]) {
  for (const event of events) {
    await owner.query(`INSERT INTO analytics_events (id,schema_version,name,occurred_at,source,platform,actor_id,journey_id,activity_id,booking_id,invite_id,context,synthetic)
      VALUES ($1,1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,true)`,
      [event.id, event.name, event.occurredAt, event.source ?? 'server', event.platform ?? 'web', event.actorId ?? null, event.journeyId ?? null,
        event.activityId ?? null, event.bookingId ?? null, event.inviteId ?? null, JSON.stringify(event.context ?? {})]);
  }
}
function outcome(actorId: string, result: string, eligibility: string, at: string, operation = 'book_activity'): EventFixture {
  return { id: randomUUID(), name: 'booking_request_outcome', occurredAt: at, actorId, context: { outcome: result, eligibility, operation } };
}


test('an eventless window reports no data rather than fabricated zero rates', async () => {
  const { status, data } = await summary('?from=2026-08-01T00:00:00Z&to=2026-08-08T00:00:00Z&includeTest=true');
  assert.equal(status, 200);
  assert.deepEqual(data.bookings.rawOutcomes, { committed: 0, replay: 0, soldOut: 0, invalid: 0, technicalError: 0, total: 0 });
  assert.equal(data.bookings.attempts, 0);
  const reliability = data.bookings.reliability;
  assert.equal(reliability.succeeded, 0);
  assert.equal(reliability.eligibleFailures, 0);
  assert.equal(reliability.unknownFailures, 0);
  assert.equal(reliability.eligibleRate, null);
  assert.equal(reliability.unknownInclusiveRate, null);
  assert.equal(reliability.status, 'no_data');
  assert.equal(reliability.target, 0.995);
  assert.equal(reliability.trigger.resolvedIntents, 1000);
  assert.equal(data.live.status, 'no_data');
  assert.equal(typeof data.live.endpoint, 'string');
});

test('summary and product windows are validated like live metrics', async () => {
  for (const invalid of ['?includeTest=yes', `?from=${to}&to=${from}`, `?from=2026-09-01T00:00:00Z&to=2026-10-08T00:00:00Z`, '?from=yesterday']) {
    const summaryResponse = await summary(invalid);
    assert.equal(summaryResponse.status, 400, invalid);
    assert.equal(summaryResponse.error.code, 'INVALID_REQUEST');
    const productResponse = await product(invalid);
    assert.equal(productResponse.status, 400, invalid);
    assert.equal(productResponse.error.code, 'INVALID_REQUEST');
  }
  const missing = await fetch(`${base}/api/metrics/summary`);
  assert.equal(missing.status, 200);
});

test('reliability classifies distinct logical intents and keeps unknown failures visible', async () => {
  // rA (eventual commit after an eligible failure), rF (replay of a committed result) and
  // rG (commit exactly at window start) succeed: S=3. rB fails eligible, rC fails unknown.
  // rD sold out and rE invalid are excluded from reliability; rH's commit sits at the
  // exclusive window end. rA's two attempts stay visible in raw counts.
  const { status, data } = await summary();
  assert.equal(status, 200);
  assert.deepEqual(data.bookings.rawOutcomes, { committed: 2, replay: 1, soldOut: 1, invalid: 1, technicalError: 3, total: 8 });
  assert.equal(data.bookings.attempts, 2);
  assert.equal(data.bookings.distinctIntents, 7);
  const reliability = data.bookings.reliability;
  assert.equal(reliability.succeeded, 3);
  assert.equal(reliability.eligibleFailures, 1);
  assert.equal(reliability.unknownFailures, 1);
  assert.equal(reliability.eligibleRate, 0.75);
  assert.equal(reliability.unknownInclusiveRate, 0.6);
  assert.equal(reliability.resolvedIntents, 4);
  assert.equal(reliability.status, 'insufficient_sample');
});

test('synthetic and test actors never contaminate product metrics by default', async () => {
  const { data } = await summary(`?from=${from}&to=${to}&includeTest=false`);
  assert.deepEqual(data.bookings.rawOutcomes, { committed: 0, replay: 0, soldOut: 0, invalid: 0, technicalError: 0, total: 0 });
  assert.equal(data.bookings.attempts, 0);
  assert.equal(data.bookings.reliability.status, 'no_data');
  assert.equal(data.bookings.reliability.eligibleRate, null);
});

test('oversold activities and counter mismatches are reported as integrity violations', async () => {
  const { data } = await summary();
  assert.equal(data.integrity.oversoldActivities, 1);
  assert.equal(data.integrity.counterMismatchActivities, 1);
  assert.equal(data.integrity.violation, true);
  const violation = data.integrity.violations.find((row: { activityId: string }) =>
    row.activityId === '22222222-0000-4000-8000-000000000090');
  assert.ok(violation, JSON.stringify(data.integrity));
  assert.equal(violation.capacity, 1);
  assert.equal(violation.bookingCount, 2);
  assert.equal(violation.confirmedCount, 0);
  assert.equal(violation.oversold, true);
  assert.equal(violation.counterMismatch, true);
});

test('booker-to-inviter counts each first window booking with a 24h invite and matures windows', async () => {
  // 19 users' first in-window bookings are mature; booker1 (23h) and booker5 (vouch, 10h)
  // invited, while booker2 (25h), booker6 (wrong activity) and everyone else did not.
  // booker3 booked too recently to judge. host1's own invite is the separate host segment.
  const { status, data } = await product();
  assert.equal(status, 200);
  const bookers = data.bookersInvite;
  assert.equal(bookers.definition, "each user's first confirmed booking in the window; an invite for that activity within 24h counts as invited");
  assert.equal(bookers.mature.qualifyingBookers, 19);
  assert.equal(bookers.mature.invitedWithin24h, 2);
  assert.ok(Math.abs(bookers.mature.rate - 2 / 19) < 1e-9);
  assert.ok(bookers.mature.wilson95[0] < 2 / 19 && bookers.mature.wilson95[1] > 2 / 19);
  assert.equal(bookers.notYetMature.qualifyingBookers, 1);
  assert.equal(bookers.notYetMature.invitedWithin24h, 1);
  assert.deepEqual(bookers.mature.invitedByRail, { vouch: 1, public: 1 });
  assert.equal(bookers.hostCreatorsWithoutBooking, 1);
  assert.equal(bookers.target, 0.3);
  assert.equal(bookers.trigger.matureBookerJourneys, 200);
  assert.equal(bookers.status, 'insufficient_sample');
});

test('open-to-claim deduplicates journeys, honours 24h and start deadlines, and separates recovery', async () => {
  // Nine mature journeys opened (J1's repeated open counts once): J1, J2, J7, J9 convert;
  // J5 converts after seeing a full preview (headline only); J3, J6 (a returning booker's
  // recovery reopen), J10 (claim after activity start) and J11 do not. J4 is not yet mature.
  const { data } = await product();
  const opens = data.openToClaim;
  assert.equal(opens.headline.openedJourneys, 9);
  assert.equal(opens.headline.convertedJourneys, 5);
  assert.ok(Math.abs(opens.headline.rate - 5 / 9) < 1e-9);
  assert.equal(opens.eligible.eligibleOpens, 7);
  assert.equal(opens.eligible.converted, 4);
  assert.ok(Math.abs(opens.eligible.rate - 4 / 7) < 1e-9);
  assert.ok(opens.eligible.wilson95[0] < 4 / 7 && opens.eligible.wilson95[1] > 4 / 7);
  assert.equal(opens.notYetMature.openedJourneys, 1);
  assert.equal(opens.notYetMature.convertedJourneys, 0);
  assert.deepEqual(opens.reasons.byDisplayedState, {
    valid: { opened: 8, converted: 4 },
    full: { opened: 1, converted: 1 },
  });
  assert.equal(opens.reasons.recoveryOpens, 1);
  assert.deepEqual(opens.byRail.vouch, { opened: 1, converted: 1 });
  assert.deepEqual(opens.byRail.public, { opened: 6, converted: 3 });
  assert.deepEqual(opens.byPlatform.mobile, { opened: 3, converted: 2 });
  assert.deepEqual(opens.byPlatform.web, { opened: 4, converted: 2 });
  assert.deepEqual(opens.byViewer.new, { opened: 6, converted: 4 });
  assert.deepEqual(opens.byViewer.returning, { opened: 1, converted: 0 });
  assert.equal(opens.target, 0.25);
  assert.equal(opens.trigger.matureJourneys, 200);
  assert.equal(opens.status, 'insufficient_sample');
});

test('k-factor freezes a host/booker cohort, splits rails, and keeps descendants by generation', async () => {
  // Cohort at window start: host1, booker0, the two pre-window integrity bookers and booker5,
  // whose earlier act0 booking predates the window (5). host1 directly acquires kGuestV + oG7
  // (vouch) and kGuestP + five open-journey guests (public); kGuestX's inviter booked only
  // inside the window and kDeep is generation 2, so both stay out of direct K but appear in
  // the generation breakdown.
  const { data } = await product();
  const k = data.kFactor;
  assert.equal(Date.parse(k.cohort.asOf), Date.parse(from));
  assert.equal(k.cohort.size, 5);
  assert.equal(k.byRail.vouch.acquired, 2);
  assert.equal(k.byRail.vouch.activated, 2);
  assert.ok(Math.abs(k.byRail.vouch.k - 0.4) < 1e-9);
  assert.ok(Math.abs(k.byRail.vouch.activatedK - 0.4) < 1e-9);
  assert.equal(k.byRail.public.acquired, 6);
  assert.equal(k.byRail.public.activated, 5);
  assert.ok(Math.abs(k.byRail.public.k - 1.2) < 1e-9);
  assert.ok(Math.abs(k.byRail.public.activatedK - 1.0) < 1e-9);
  assert.deepEqual(k.newUsersByGeneration, [{ generation: 1, users: 9 }, { generation: 2, users: 1 }]);
  assert.equal(k.target, null);
});

test('holdout compares every assigned activity on participants and provisional formed plans', async () => {
  // The four metrics-holdout activities carry no exposure or invitation events at all:
  // the denominator is assignment, not usage. Treatment holds 3+1 participants (one formed
  // plan), control 2+0 (one formed plan); the participant difference carries a wide CI.
  const { data } = await product();
  const block = data.holdout.byVersion.find((version: { version: string }) => version.version === 'metrics-holdout');
  assert.ok(block, JSON.stringify(data.holdout));
  assert.equal(block.treatment.activities, 2);
  assert.equal(block.treatment.participants, 4);
  assert.ok(Math.abs(block.treatment.meanParticipantsPerActivity - 2) < 1e-9);
  assert.equal(block.treatment.formedPlans, 1);
  assert.equal(block.control.activities, 2);
  assert.equal(block.control.participants, 2);
  assert.ok(Math.abs(block.control.meanParticipantsPerActivity - 1) < 1e-9);
  assert.equal(block.control.formedPlans, 1);
  assert.ok(Math.abs(block.difference.participantsPerActivity - 1) < 1e-9);
  const spread = 1.96 * Math.sqrt(2);
  assert.ok(Math.abs(block.difference.participantsPerActivityCi95[0] - (1 - spread)) < 1e-4);
  assert.ok(Math.abs(block.difference.participantsPerActivityCi95[1] - (1 + spread)) < 1e-4);
  assert.ok(Math.abs(block.difference.formedPlanRate - 0) < 1e-9);
  assert.equal(block.attendance, 'unmeasured');
  assert.equal(block.includesUnexposed, true);
  assert.equal(block.observationalOnly, true);
  assert.equal(data.holdout.experiment, 'group_invites_v1');
});

test('an empty window shows no data across every product block', async () => {
  const { data } = await product('?from=2026-08-01T00:00:00Z&to=2026-08-08T00:00:00Z&includeTest=true');
  assert.equal(data.bookersInvite.status, 'no_data');
  assert.equal(data.bookersInvite.mature.rate, null);
  assert.equal(data.openToClaim.status, 'no_data');
  assert.equal(data.openToClaim.headline.rate, null);
  assert.equal(data.kFactor.status, 'no_data');
  assert.deepEqual(data.kFactor.newUsersByGeneration, []);
  assert.deepEqual(data.holdout.byVersion, []);
});

test('synthetic product traffic stays out of the default view', async () => {
  const { data } = await product(`?from=${from}&to=${to}&includeTest=false`);
  assert.equal(data.bookersInvite.status, 'no_data');
  assert.equal(data.openToClaim.status, 'no_data');
  assert.equal(data.kFactor.status, 'no_data');
  assert.equal(data.kFactor.cohort.size, 0);
  assert.deepEqual(data.holdout.byVersion, []);
});
