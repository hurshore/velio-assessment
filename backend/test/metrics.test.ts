import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { before, after, test } from 'node:test';
import pg from 'pg';
import { createApp } from '../src/app.js';
import { loadInviteConfig } from '../src/experiments.js';
import { runMigrations } from '../src/migrations.js';
import {
  bookerInviteTarget, bookerMinMatureJourneys, inviteWindowHours, kWindowDays, maxIntegrityDetails, openClaimSkewToleranceMinutes,
  openClaimTarget, openMinMatureJourneys, reliabilityMinResolvedIntents, reliabilityTarget,
} from '../src/metric-policy.js';
import { withReportSnapshot } from '../src/reporting.js';

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
  // eligible/unknown; rD sold out and rE invalid are excluded from reliability; rF only replays
  // an earlier result (not a new intent); rG commits exactly at the window start; rH commits
  // exactly at the end. rD also has two unrelated technical failures whose activity never
  // resolved: nothing correlates them, so each stays its own unknown intent.
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
    // A technical failure before any identity resolved still counts as its own unknown intent.
    { id: randomUUID(), name: 'booking_request_outcome', occurredAt: '2026-10-03T14:00:00Z', journeyId: journey('99'),
      context: { outcome: 'technical_error', eligibility: 'unknown', operation: 'book_activity', requestId: randomUUID() } },
    unresolvedFailure(rD, '2026-10-03T15:00:00Z'),
    unresolvedFailure(rD, '2026-10-03T16:00:00Z'),
  ]);
  // Live delivery, written with the same shapes saveObservation produces:
  // E1 (rA) reached two foreground clients: one ACK in 500ms, one never ACKed before its deadline.
  // E2 (rB) committed with nobody subscribed: an observation with expected=0 and no deliveries.
  // E3 (rC) is mixed: its origin gateway delivered to one client (ACK 1200ms); a second gateway
  // observed it through recovery with no subscribers.
  await liveBookingFixture(actR, rA, 2, '2026-10-02T10:00:30Z', [{ timing: 'commit_observed', deliveries: [500, null] }]);
  await liveBookingFixture(actR, rB, 3, '2026-10-06T10:00:00Z', [{ timing: 'commit_observed', deliveries: [] }]);
  await liveBookingFixture(actR, rC, 4, '2026-10-04T10:00:00Z', [
    { timing: 'commit_observed', deliveries: [1200] }, { timing: 'pre_commit_proxy', deliveries: [] }]);
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
  await organicUser(user('47'), '2026-09-25T09:00:00Z', 'Holdout late participant');
  await booking(randomUUID(), act8, user('47'), '2026-10-09T10:00:00Z');
  // Fixture bookings bypass the counter-updating transaction, so align stored counts with
  // rows everywhere except the deliberate act9 violation.
  await owner.query(`UPDATE activities a SET confirmed_count = (SELECT count(*) FROM bookings b WHERE b.activity_id=a.id)
    WHERE id <> '22222222-0000-4000-8000-000000000090'`);
  // 101 more activities whose counter claims a seat no booking row backs: with act9 that makes
  // 102 violating activities, more than the 100-row detail cap.
  // Fixed August timestamps keep them out of every reporting window used below.
  const client = await owner.connect();
  try {
    await client.query('BEGIN');
    await client.query(`WITH created AS (
      INSERT INTO activities (host_id,title,description,meeting_location,starts_at,timezone,capacity,confirmed_count,price_minor,currency,created_at)
      SELECT $1,'Counter fixture','Mismatched counter','Fixture gate','2030-01-01T09:00:00Z','UTC',2,1,0,'NGN','2026-08-15T10:00:00Z'
      FROM generate_series(1,101) RETURNING id) SELECT assign_invite_experiment(id,'integrity-cap',50) FROM created`, [host1]);
    await client.query(`UPDATE experiment_assignments SET assigned_at='2026-08-15T10:00:00Z' WHERE version='integrity-cap'`);
    await client.query('COMMIT');
  } finally { client.release(); }
  await timingFixtures();
  await markerFixtures();
}

// Open timing (window 2026-09-10..09-17). Invite T is created 07:00 and expires 24h later;
// T2 is created 16:00. Effective open = reported time clamped to [invite creation, receipt].
//   K1 clock ahead 3s, fast claim before the (late) reported time        -> converts
//   K2 clock ahead, open uploaded after the claim, claim 20s earlier     -> converts (5 min tolerance)
//   K3 clock 4h behind, reported before the invite existed; claim 23.5h  -> converts (clamped to creation)
//   K4 offline open uploaded 2h late, claim between occurrence and upload -> converts
//   K5 claim 30 minutes before the open                                   -> does not convert
//   K6 one journey opens T then T2 and claims through T2: (T,K6) does not convert, (T2,K6) does
const timingFrom = '2026-09-10T00:00:00Z', timingTo = '2026-09-17T00:00:00Z';
async function timingFixtures() {
  const actT = '22222222-0000-4000-8000-000000000070';
  await activity(actT, host1, '2030-01-01T09:00:00Z', '2026-09-01T10:00:00Z');
  await invite(inviteId('70'), inviteCodeText('70'), actT, host1, 'host', 'public', '2026-09-10T07:00:00Z', '2026-09-11T07:00:00Z', 0, host1);
  await invite(inviteId('71'), inviteCodeText('71'), actT, host1, 'host', 'public', '2026-09-10T16:00:00Z', '2026-09-11T16:00:00Z', 0, host1);
  const opened = (suffix: string, inviteSuffix: string, occurredAt: string, receivedAt: string): EventFixture => ({
    id: randomUUID(), name: 'invite_opened', occurredAt, receivedAt, source: 'client', platform: 'mobile',
    journeyId: journey(suffix), inviteId: inviteId(inviteSuffix),
    context: { rail: 'public', displayedState: 'valid', stateAtReceipt: 'valid', recovery: false } });
  const claimed = (suffix: string, inviteSuffix: string, at: string): EventFixture => ({
    id: randomUUID(), name: 'spot_claimed', occurredAt: at, platform: 'mobile', journeyId: journey(suffix), inviteId: inviteId(inviteSuffix),
    context: { operation: 'claim_invite', rail: 'public', outcome: 'committed' } });
  await recordEvents([
    opened('71', '70', '2026-09-10T09:00:03Z', '2026-09-10T09:00:00.200Z'), claimed('71', '70', '2026-09-10T09:00:01Z'),
    opened('72', '70', '2026-09-10T10:00:30Z', '2026-09-10T10:05:00Z'), claimed('72', '70', '2026-09-10T10:00:10Z'),
    opened('73', '70', '2026-09-10T06:00:00Z', '2026-09-10T10:00:01Z'), claimed('73', '70', '2026-09-11T06:30:00Z'),
    opened('74', '70', '2026-09-10T12:00:00Z', '2026-09-10T14:00:00Z'), claimed('74', '70', '2026-09-10T12:30:00Z'),
    opened('75', '70', '2026-09-10T15:00:00Z', '2026-09-10T15:00:00Z'), claimed('75', '70', '2026-09-10T14:30:00Z'),
    opened('76', '70', '2026-09-10T16:30:00Z', '2026-09-10T16:30:00Z'), opened('76', '71', '2026-09-10T16:40:00Z', '2026-09-10T16:40:00Z'),
    claimed('76', '71', '2026-09-10T17:00:00Z'),
  ]);
}

// Marker alignment (window 2026-10-20..10-27, after the main window so its users never join
// the main cohort). These rows are unmarked unless noted, so includeTest=false sees them.
//   Holdout: treatment HT3 has unmarked U1 and test-marked M1; control HC3 has only test-marked
//   M2, so it keeps one activity with zero qualifying participants.
//   K: unmarked host RH and test-marked host MP both hosted before the window; RH acquires N1
//   and MP acquires N2 (left unmarked, as legacy data might be), which must not count.
//   Opens: Q1 is an unmarked open claimed by a test-marked actor; Q2 is an unmarked open.
const markerFrom = '2026-10-20T00:00:00Z', markerTo = '2026-10-27T00:00:00Z';
async function markerFixtures() {
  const rh = user('81'), mp = user('82'), u1 = user('83'), m1 = user('84'), m2 = user('85'), n1 = user('86'), n2 = user('87');
  const hostedBefore = '22222222-0000-4000-8000-000000000080', mpHosted = '22222222-0000-4000-8000-000000000081';
  const ht3 = '22222222-0000-4000-8000-000000000082', hc3 = '22222222-0000-4000-8000-000000000083';
  await organicUser(rh, '2026-10-10T09:00:00Z', 'Real host', null, {});
  await organicUser(mp, '2026-10-10T09:00:00Z', 'Marked host', null, { test: true });
  for (const [id, label, markers] of [[u1, 'Real participant', {}], [m1, 'Marked participant', { test: true }], [m2, 'Marked control participant', { test: true }]] as const) {
    await organicUser(id, '2026-10-10T09:00:00Z', label, null, markers);
  }
  await activity(hostedBefore, rh, '2030-01-01T09:00:00Z', '2026-10-15T10:00:00Z');
  await activity(mpHosted, mp, '2030-01-01T09:00:00Z', '2026-10-15T10:00:00Z');
  await activity(ht3, rh, '2030-01-01T09:00:00Z', '2026-10-21T10:00:00Z', 20, 'metrics-holdout-markers', 100);
  await activity(hc3, rh, '2030-01-01T09:00:00Z', '2026-10-21T10:00:00Z', 20, 'metrics-holdout-markers', 0);
  await booking(randomUUID(), ht3, u1, '2026-10-22T10:00:00Z');
  await booking(randomUUID(), ht3, m1, '2026-10-22T10:00:00Z');
  await booking(randomUUID(), hc3, m2, '2026-10-22T10:00:00Z');
  await invite(inviteId('80'), inviteCodeText('80'), hostedBefore, rh, 'host', 'public', '2026-10-21T09:00:00Z', '2026-10-22T09:00:00Z', 0, rh);
  await invite(inviteId('81'), inviteCodeText('81'), mpHosted, mp, 'host', 'public', '2026-10-21T09:00:00Z', '2026-10-22T09:00:00Z', 0, mp);
  await invitedUser(n1, 'Real acquisition', '2026-10-21T10:00:00Z', inviteId('80'), rh, rh, 1, 'public', null, {});
  await invitedUser(n2, 'Acquisition by marked parent', '2026-10-21T10:00:00Z', inviteId('81'), mp, mp, 1, 'public', null, {});
  await recordEvents([
    { id: randomUUID(), name: 'invite_opened', occurredAt: '2026-10-21T11:00:00Z', source: 'client', platform: 'web', journeyId: journey('81'),
      inviteId: inviteId('80'), context: { rail: 'public', displayedState: 'valid', recovery: false }, markers: {} },
    { id: randomUUID(), name: 'spot_claimed', occurredAt: '2026-10-21T11:30:00Z', journeyId: journey('81'), inviteId: inviteId('80'),
      actorId: m1, context: { operation: 'claim_invite', rail: 'public', outcome: 'committed' }, markers: { test: true } },
    { id: randomUUID(), name: 'invite_opened', occurredAt: '2026-10-21T12:00:00Z', source: 'client', platform: 'web', journeyId: journey('82'),
      inviteId: inviteId('80'), context: { rail: 'public', displayedState: 'valid', recovery: false }, markers: {} },
  ]);
  await owner.query(`UPDATE activities a SET confirmed_count = (SELECT count(*) FROM bookings b WHERE b.activity_id=a.id)
    WHERE id IN ($1,$2)`, [ht3, hc3]);
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

// Fixtures are synthetic unless markers say otherwise; only the marker-alignment window
// (markerFixtures) passes explicit markers so includeTest=false has something to show.
interface Markers { synthetic?: boolean; test?: boolean }
const syntheticMarker: Markers = { synthetic: true };
async function organicUser(id: string, createdAt: string, name: string, contact: string | null = null, markers: Markers = syntheticMarker) {
  await owner.query(`INSERT INTO users (id,display_name,contact,generation,acquisition_root_id,synthetic,test,created_at)
    VALUES ($1,$2,$3,0,$1,$5,$6,$4) ON CONFLICT (id) DO NOTHING`, [id, name, contact, createdAt, markers.synthetic ?? false, markers.test ?? false]);
  await owner.query(`INSERT INTO signup_attribution (user_id,generation,root_id,created_at)
    VALUES ($1,0,$1,$2) ON CONFLICT (user_id) DO NOTHING`, [id, createdAt]);
}
async function invitedUser(id: string, name: string, createdAt: string, inviteIdText: string, inviterId: string, inviterRootId: string, generation: number, rail: string,
  contact: string | null = null, markers: Markers = syntheticMarker) {
  await owner.query(`INSERT INTO users (id,display_name,contact,generation,acquisition_parent_id,acquisition_root_id,acquisition_invite_id,acquisition_rail,synthetic,test,created_at)
    VALUES ($1,$2,$9,$3,$4,$5,$6,$7,$10,$11,$8) ON CONFLICT (id) DO NOTHING`,
    [id, name, generation, inviterId, inviterRootId, inviteIdText, rail, createdAt, contact, markers.synthetic ?? false, markers.test ?? false]);
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
interface EventFixture { id: string; name: string; occurredAt: string; receivedAt?: string; source?: string; platform?: string; actorId?: string | null; journeyId?: string | null;
  activityId?: string | null; bookingId?: string | null; inviteId?: string | null; context?: object; markers?: Markers }
async function recordEvents(events: EventFixture[]) {
  for (const event of events) {
    const markers = event.markers ?? syntheticMarker;
    // Receipt defaults to occurrence: these fixtures model prompt server-side ingestion.
    await owner.query(`INSERT INTO analytics_events (id,schema_version,name,occurred_at,received_at,source,platform,actor_id,journey_id,activity_id,booking_id,invite_id,context,synthetic,test)
      VALUES ($1,1,$2,$3,$12,$4,$5,$6,$7,$8,$9,$10,$11,$13,$14)`,
      [event.id, event.name, event.occurredAt, event.source ?? 'server', event.platform ?? 'web', event.actorId ?? null, event.journeyId ?? null,
        event.activityId ?? null, event.bookingId ?? null, event.inviteId ?? null, JSON.stringify(event.context ?? {}),
        event.receivedAt ?? event.occurredAt, markers.synthetic ?? false, markers.test ?? false]);
  }
}
// Mirrors bookSeat's outcome shape: the activity and request id live in context.
function outcome(actorId: string, result: string, eligibility: string, at: string, operation = 'book_activity'): EventFixture {
  return { id: randomUUID(), name: 'booking_request_outcome', occurredAt: at, actorId,
    context: { outcome: result, eligibility, operation, activityId: actR, requestId: randomUUID() } };
}
// Mirrors recordInvalidBooking when the actor resolved but the activity did not.
function unresolvedFailure(actorId: string, at: string): EventFixture {
  return { id: randomUUID(), name: 'booking_request_outcome', occurredAt: at, actorId,
    context: { outcome: 'technical_error', eligibility: 'unknown', operation: 'book_activity', stage: 'validation', requestId: randomUUID() } };
}
interface ObservationFixture { timing: 'commit_observed' | 'pre_commit_proxy'; deliveries: (number | null)[] }
// One committed booking with its outbox event and per-gateway observations, as saveObservation
// writes them: expected equals the captured subscribers, each with a delivery row. A delay is
// an ACK after that many milliseconds; null never ACKed before its two-second deadline.
async function liveBookingFixture(activityId: string, userId: string, version: number, at: string, observations: ObservationFixture[]) {
  const bookingId = randomUUID(), eventId = randomUUID();
  const processes = observations.map(() => randomUUID());
  await booking(bookingId, activityId, userId, at);
  await owner.query(`INSERT INTO outbox_events (id,name,activity_id,booking_id,version,payload,created_at,origin_process_id)
    VALUES ($1,'availability_updated',$2,$3,$4,'{}',$5,$6)`, [eventId, activityId, bookingId, version, at, processes[0]]);
  for (const [index, observation] of observations.entries()) {
    await owner.query(`INSERT INTO live_observations (event_id,process_id,timing,observed_at,started_clock,expected)
      VALUES ($1,$2,$3,$4,0,$5)`, [eventId, processes[index], observation.timing, at, observation.deliveries.length]);
    for (const delay of observation.deliveries) {
      await owner.query(`INSERT INTO live_deliveries (event_id,process_id,connection_id,client_id,deadline,ack_at,sent_version,delay_ms)
        VALUES ($1,$2,$3,$4,$5::timestamptz + interval '2 seconds',$5::timestamptz + $6 * interval '1 millisecond',$7,$8)`,
        [eventId, processes[index], randomUUID(), randomUUID(), at, delay, version, delay]);
    }
  }
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
  assert.equal(reliability.target, reliabilityTarget);
  assert.equal(reliability.trigger.resolvedIntents, reliabilityMinResolvedIntents);
  assert.equal(data.live.status, 'no_data');
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

test('reliability follows the logical-intent policy and keeps unknown failures visible', async () => {
  // S: rA (eligible failure retried into a commit) and rG (commit exactly at window start).
  // F: rB. U: rC, the request whose identity never resolved, and rD's two unrelated failures
  // whose activity never resolved (kept apart rather than merged). Excluded but reported:
  // rF's replay-only intent, rD's sold-out intent and rE's invalid request. rH's commit sits
  // at the exclusive window end.
  const { status, data } = await summary();
  assert.equal(status, 200);
  assert.deepEqual(data.bookings.rawOutcomes, { committed: 2, replay: 1, soldOut: 1, invalid: 1, technicalError: 6, total: 11 });
  assert.equal(data.bookings.attempts, 2);
  assert.equal(data.bookings.distinctIntents, 10);
  assert.equal(data.bookings.retriedIntents, 1);
  assert.ok(Math.abs(data.bookings.technicalErrorRate - 6 / 11) < 1e-9);
  assert.deepEqual(data.bookings.excludedIntents, { replayOnly: 1, soldOut: 1, invalid: 1 });
  const reliability = data.bookings.reliability;
  assert.equal(reliability.succeeded, 2);
  assert.equal(reliability.eligibleFailures, 1);
  assert.equal(reliability.unknownFailures, 4);
  assert.ok(Math.abs(reliability.eligibleRate - 2 / 3) < 1e-9);
  assert.ok(Math.abs(reliability.unknownInclusiveRate - 2 / 7) < 1e-9);
  assert.equal(reliability.resolvedIntents, 3);
  assert.equal(reliability.status, 'insufficient_sample');
});

const liveFields = ['timing', 'observedBookings', 'bookingsWithSubscribers', 'expectedDeliveries', 'acknowledged', 'onTimeAcknowledged',
  'deliveryMisses', 'pending', 'eventualAckCoverage', 'onTimeCoverage', 'ackOnlyBookingSamples', 'ackOnlyPerBookingP95Ms', 'everyClientTargetMet', 'analysis'];
async function liveParity(query: string) {
  const { data } = await summary(query);
  const live = (await (await fetch(`${base}/api/metrics/live${query}`)).json()).data;
  assert.equal(data.live.report, `/api/metrics/live?${new URLSearchParams({ includeTest: String(data.includeTest), from: data.window.from, to: data.window.to })}`);
  assert.deepEqual(data.live.groups, live.groups.map((group: Record<string, unknown>) => Object.fromEntries(liveFields.map(field => [field, group[field]]))));
  assert.equal(data.live.instrumentationGaps, live.instrumentationGaps);
  return data.live;
}

test('live delivery summary counts only real subscribers and matches the live report', async () => {
  // E1: 2 expected, 1 ACK at 500ms, 1 miss. E2: observed with no subscribers. E3: 1 ACK at
  // 1200ms at its origin; a second gateway observed it by proxy with no subscribers.
  const live = await liveParity(`?from=${from}&to=${to}&includeTest=true`);
  assert.equal(live.status, 'reported');
  assert.equal(live.instrumentationGaps, 0);
  const [commit, proxy] = live.groups;
  assert.deepEqual(commit, { timing: 'commit_observed', observedBookings: 3, bookingsWithSubscribers: 2, expectedDeliveries: 3,
    acknowledged: 2, onTimeAcknowledged: 2, deliveryMisses: 1, pending: 0, eventualAckCoverage: 2 / 3, onTimeCoverage: 2 / 3,
    ackOnlyBookingSamples: 2, ackOnlyPerBookingP95Ms: 1200, everyClientTargetMet: false,
    analysis: { status: 'insufficient_sample', observedBookingUpdates: 2, minObservedBookingUpdates: 50 } });
  assert.deepEqual(proxy, { timing: 'pre_commit_proxy', observedBookings: 1, bookingsWithSubscribers: 0, expectedDeliveries: 0,
    acknowledged: 0, onTimeAcknowledged: 0, deliveryMisses: 0, pending: 0, eventualAckCoverage: null, onTimeCoverage: null,
    ackOnlyBookingSamples: 0, ackOnlyPerBookingP95Ms: null, everyClientTargetMet: null,
    analysis: { status: 'no_data', observedBookingUpdates: 0, minObservedBookingUpdates: 50 } });
});

test('a booking nobody watched is neither a pending delivery nor an SLO pass', async () => {
  const zeroOnly = await liveParity('?from=2026-10-06T00:00:00Z&to=2026-10-07T00:00:00Z&includeTest=true');
  assert.equal(zeroOnly.status, 'no_expected_deliveries');
  assert.equal(zeroOnly.groups[0].observedBookings, 1);
  assert.equal(zeroOnly.groups[0].expectedDeliveries, 0);
  assert.equal(zeroOnly.groups[0].pending, 0);
  assert.equal(zeroOnly.groups[0].everyClientTargetMet, null);
  // The mixed booking passes only for the gateway that had a subscriber.
  const mixed = await liveParity('?from=2026-10-04T00:00:00Z&to=2026-10-05T00:00:00Z&includeTest=true');
  assert.equal(mixed.status, 'reported');
  assert.equal(mixed.groups[0].expectedDeliveries, 1);
  assert.equal(mixed.groups[0].everyClientTargetMet, true);
  assert.equal(mixed.groups[1].observedBookings, 1);
  assert.equal(mixed.groups[1].everyClientTargetMet, null);
  const filtered = await liveParity(`?from=${from}&to=${to}&includeTest=false`);
  assert.equal(filtered.status, 'no_data');
});

test('live analysis reports the 50-update trigger separately from latency and coverage', async () => {
  const { data } = await summary();
  const detail = (await (await fetch(`${base}/api/metrics/live?from=${from}&to=${to}&includeTest=true`)).json()).data;
  assert.deepEqual(data.live.groups[0].analysis, {
    status: 'insufficient_sample', observedBookingUpdates: 2, minObservedBookingUpdates: 50,
  });
  assert.deepEqual(data.live.groups[0].analysis, detail.groups[0].analysis);
  assert.deepEqual(data.live.groups[1].analysis, {
    status: 'no_data', observedBookingUpdates: 0, minObservedBookingUpdates: 50,
  });
});

test('synthetic and test actors never contaminate windowed summary metrics by default', async () => {
  const { data } = await summary(`?from=${from}&to=${to}&includeTest=false`);
  assert.deepEqual(data.bookings.rawOutcomes, { committed: 0, replay: 0, soldOut: 0, invalid: 0, technicalError: 0, total: 0 });
  assert.equal(data.bookings.attempts, 0);
  assert.equal(data.bookings.reliability.status, 'no_data');
  assert.equal(data.bookings.reliability.eligibleRate, null);
  assert.equal(data.live.status, 'no_data');
  // Integrity is a global current-state check: markers and the window never hide an oversell.
  assert.equal(data.integrity.oversoldActivities, 1);
});

test('integrity reports every violation total and caps detail rows', async () => {
  const { data } = await summary();
  assert.equal(data.integrity.oversoldActivities, 1);
  assert.equal(data.integrity.counterMismatchActivities, 102);
  assert.equal(data.integrity.violatingActivities, 102);
  assert.equal(data.integrity.violation, true);
  assert.equal(data.integrity.violations.length, maxIntegrityDetails);
  assert.deepEqual(data.integrity.details, { limit: maxIntegrityDetails, truncated: true, omittedViolations: 2 });
  // Oversells sort first, so the cap never hides them behind counter-only mismatches.
  assert.deepEqual(data.integrity.violations[0], { activityId: '22222222-0000-4000-8000-000000000090', capacity: 1,
    confirmedCount: 0, bookingCount: 2, oversold: true, counterMismatch: true });
});

test('booker-to-inviter counts each first window booking with a 24h invite and matures windows', async () => {
  // 22 users' first in-window bookings are mature (14 organic, 8 invited generation-1
  // guests); booker1 (23h) and booker5 (vouch, 10h) invited, while booker2 (25h), booker6
  // (wrong activity) and everyone else did not. booker3 booked too recently to judge.
  // host1's own invite is the separate host segment.
  const { status, data } = await product();
  assert.equal(status, 200);
  const bookers = data.bookersInvite;
  assert.equal(bookers.mature.qualifyingBookers, 22);
  assert.equal(bookers.mature.invitedWithin24h, 2);
  assert.ok(Math.abs(bookers.mature.rate - 2 / 22) < 1e-9);
  assert.ok(bookers.mature.wilson95[0] < 2 / 22 && bookers.mature.wilson95[1] > 2 / 22);
  assert.deepEqual(bookers.mature.bySignupGeneration, {
    0: { qualifyingBookers: 14, invitedWithin24h: 2 },
    1: { qualifyingBookers: 8, invitedWithin24h: 0 },
  });
  assert.equal(bookers.notYetMature.qualifyingBookers, 1);
  assert.equal(bookers.notYetMature.invitedWithin24h, 1);
  assert.deepEqual(bookers.mature.invitedByRail, { vouch: 1, public: 1 });
  assert.equal(bookers.hostCreatorsWithoutBooking, 1);
  assert.equal(bookers.target, bookerInviteTarget);
  assert.equal(bookers.trigger.matureBookerJourneys, bookerMinMatureJourneys);
  assert.equal(bookers.status, 'insufficient_sample');
});

test('open-to-claim deduplicates journeys, honours 24h and start deadlines, and separates recovery', async () => {
  // Eight mature acquisition journeys opened (J1's repeated open counts once): J1, J2, J7,
  // J9 (claim exactly 24h after its open) convert; J5 converts after seeing a full preview
  // (headline only); J3, J10 (claim after activity start) and J11 do not. J6 is a returning
  // booker's recovery reopen, reported separately and kept out of every rate. J4 is not yet mature.
  const { data } = await product();
  const opens = data.openToClaim;
  assert.equal(opens.headline.openedJourneys, 8);
  assert.equal(opens.headline.convertedJourneys, 5);
  assert.ok(Math.abs(opens.headline.rate - 5 / 8) < 1e-9);
  assert.equal(opens.eligible.eligibleOpens, 7);
  assert.equal(opens.eligible.converted, 4);
  assert.ok(Math.abs(opens.eligible.rate - 4 / 7) < 1e-9);
  assert.ok(opens.eligible.wilson95[0] < 4 / 7 && opens.eligible.wilson95[1] > 4 / 7);
  assert.equal(opens.notYetMature.openedJourneys, 1);
  assert.equal(opens.notYetMature.convertedJourneys, 0);
  assert.deepEqual(opens.reasons.byDisplayedState, {
    valid: { opened: 7, converted: 4 },
    full: { opened: 1, converted: 1 },
  });
  assert.equal(opens.reasons.recoveryOpens, 1);
  assert.deepEqual(opens.byRail.vouch, { opened: 1, converted: 1 });
  assert.deepEqual(opens.byRail.public, { opened: 6, converted: 3 });
  assert.deepEqual(opens.byPlatform.mobile, { opened: 3, converted: 2 });
  assert.deepEqual(opens.byPlatform.web, { opened: 4, converted: 2 });
  assert.deepEqual(opens.byViewer.new, { opened: 6, converted: 4 });
  assert.deepEqual(opens.byViewer.returning, { opened: 1, converted: 0 });
  assert.deepEqual(opens.byInviterGeneration, { 0: { opened: 7, converted: 4 } });
  assert.equal(opens.target, openClaimTarget);
  assert.equal(opens.trigger.matureJourneys, openMinMatureJourneys);
  assert.equal(opens.status, 'insufficient_sample');
});

test('conversion timing tolerates clocks ahead or behind, late uploads and overlapping invites', async () => {
  // See timingFixtures: K1–K4 and (T2,K6) convert; K5 and (T,K6) do not.
  const { data } = await product(`?from=${timingFrom}&to=${timingTo}&includeTest=true`);
  const opens = data.openToClaim;
  assert.equal(opens.headline.openedJourneys, 7);
  assert.equal(opens.headline.convertedJourneys, 5);
  assert.equal(opens.eligible.eligibleOpens, 7);
  assert.equal(opens.eligible.converted, 5);
  const units = (await owner.query(`SELECT journey_id, invite_id, opened_at, converted FROM metric_invite_open_units
    WHERE journey_id::text LIKE '55555555-0000-4000-8000-00000000007%'
    ORDER BY journey_id, opened_at`)).rows;
  const byJourney = (suffix: string, inviteSuffix = '70') => units.find(unit => unit.journey_id === journey(suffix) && unit.invite_id === inviteId(inviteSuffix));
  // Clock ahead: clamped to receipt. Clock behind: clamped to invite creation. Late upload: kept.
  assert.equal(byJourney('71').opened_at.toISOString(), '2026-09-10T09:00:00.200Z');
  assert.equal(byJourney('73').opened_at.toISOString(), '2026-09-10T07:00:00.000Z');
  assert.equal(byJourney('74').opened_at.toISOString(), '2026-09-10T12:00:00.000Z');
  assert.deepEqual(['71', '72', '73', '74', '75'].map(suffix => byJourney(suffix).converted), [true, true, true, true, false]);
  assert.equal(byJourney('76').converted, false);
  assert.equal(byJourney('76', '71').converted, true);
});

test('the open-unit view encodes the shared timing policy', async () => {
  const [{ definition }] = (await owner.query(`SELECT pg_get_viewdef('metric_invite_open_units') AS definition`)).rows;
  assert.ok(definition.includes(`'${inviteWindowHours}:00:00'::interval`), definition);
  assert.ok(definition.includes(`'00:${String(openClaimSkewToleranceMinutes).padStart(2, '0')}:00'::interval`), definition);
});

test('k-factor freezes a host/booker cohort, splits rails, and keeps descendants by generation', async () => {
  // Cohort at window start: host1, booker0, the two pre-window integrity bookers and booker5,
  // whose earlier act0 booking predates the window (5). host1 directly acquires kGuestV + oG7
  // (vouch) and kGuestP + five open-journey guests (public). Activation needs a claim:
  // kGuestV only booked directly and kGuestP never booked. kGuestX's inviter booked only
  // inside the window and kDeep is generation 2, so both stay out of direct K but appear in
  // the generation breakdown.
  const { data } = await product();
  const k = data.kFactor;
  assert.equal(Date.parse(k.cohort.asOf), Date.parse(from));
  assert.deepEqual(k.window, { days: 7, planned: kWindowDays });
  assert.equal(k.cohort.size, 5);
  assert.equal(k.byRail.vouch.acquired, 2);
  assert.equal(k.byRail.vouch.activated, 1);
  assert.ok(Math.abs(k.byRail.vouch.k - 0.4) < 1e-9);
  assert.ok(Math.abs(k.byRail.vouch.activatedK - 0.2) < 1e-9);
  assert.equal(k.byRail.public.acquired, 6);
  assert.equal(k.byRail.public.activated, 5);
  assert.ok(Math.abs(k.byRail.public.k - 1.2) < 1e-9);
  assert.ok(Math.abs(k.byRail.public.activatedK - 1.0) < 1e-9);
  assert.deepEqual(k.newUsersByGeneration, [{ generation: 1, users: 9 }, { generation: 2, users: 1 }]);
  assert.equal(k.target, null);
  assert.equal(k.status, 'observed');
  const short = await product('?from=2026-10-01T00:00:00Z&to=2026-10-04T00:00:00Z&includeTest=true');
  assert.equal(short.data.kFactor.window.days, 3);
  assert.equal(short.data.kFactor.status, 'partial_window');
});

test('holdout compares every assigned activity on participants and provisional formed plans', async () => {
  // The four metrics-holdout activities carry no exposure or invitation events at all:
  // the denominator is assignment, not usage. Treatment holds 3+1 participants (one formed
  // plan), control 2+0 (one formed plan); a control booking after the window closes does not
  // count. The participant difference carries a wide CI.
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

test('marker filtering uses trusted context for holdout participants, acquisition parents and claims', async () => {
  const filtered = (await product(`?from=${markerFrom}&to=${markerTo}&includeTest=false`)).data;
  const unfiltered = (await product(`?from=${markerFrom}&to=${markerTo}&includeTest=true`)).data;
  // Holdout: marked participants leave the counts; the control activity with only a marked
  // participant stays in its arm with zero qualifying participants.
  const holdoutFiltered = filtered.holdout.byVersion.find((version: { version: string }) => version.version === 'metrics-holdout-markers');
  assert.deepEqual([holdoutFiltered.treatment.activities, holdoutFiltered.treatment.participants, holdoutFiltered.treatment.formedPlans], [1, 1, 0]);
  assert.deepEqual([holdoutFiltered.control.activities, holdoutFiltered.control.participants, holdoutFiltered.control.formedPlans], [1, 0, 0]);
  const holdoutAll = unfiltered.holdout.byVersion.find((version: { version: string }) => version.version === 'metrics-holdout-markers');
  assert.deepEqual([holdoutAll.treatment.participants, holdoutAll.treatment.formedPlans, holdoutAll.control.participants], [2, 1, 1]);
  // K: the marked host is outside the cohort, so its unmarked acquisition does not count, and
  // the generation breakdown drops users whose acquisition parent is marked.
  assert.equal(filtered.kFactor.cohort.size, 1);
  assert.deepEqual(filtered.kFactor.byRail.public, { acquired: 1, activated: 0, k: 1, activatedK: 0 });
  assert.deepEqual(filtered.kFactor.newUsersByGeneration, [{ generation: 1, users: 1 }]);
  // Opens: a unit claimed by a test-marked actor is excluded with its claim.
  assert.deepEqual([filtered.openToClaim.headline.openedJourneys, filtered.openToClaim.headline.convertedJourneys], [1, 0]);
  assert.deepEqual([unfiltered.openToClaim.headline.openedJourneys, unfiltered.openToClaim.headline.convertedJourneys], [2, 1]);
  // Bookers: only the unmarked participant's booking qualifies.
  assert.equal(filtered.bookersInvite.mature.qualifyingBookers, 1);
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

test('reports run in one bounded read-only snapshot and concurrent requests agree', async () => {
  const settings = await withReportSnapshot(runtime, async snapshot => (await snapshot.query(`SELECT current_setting('transaction_isolation') AS isolation,
    current_setting('transaction_read_only') AS read_only, current_setting('statement_timeout') AS timeout`) as { rows: Record<string, string>[] }).rows[0]);
  assert.deepEqual(settings, { isolation: 'repeatable read', read_only: 'on', timeout: '1500ms' });
  const reports = await Promise.all(Array.from({ length: 6 }, () => product()));
  assert.ok(reports.every(report => report.status === 200));
  assert.ok(reports.every(report => JSON.stringify(report.data) === JSON.stringify(reports[0]!.data)));
});
