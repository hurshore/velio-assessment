import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { before, after, test } from 'node:test';
import pg from 'pg';
import { createApp } from '../src/app.js';
import { loadInviteConfig } from '../src/experiments.js';
import { runMigrations } from '../src/migrations.js';
import { applySeeds } from '../src/seed-files.js';

// Smoke check for `npm run seed`: every seed file applies twice to a fresh database, and the
// metric demonstration (seeds/metrics.sql) reports the hand-calculated results documented in
// docs/verification/product-metrics.md.
const name = `velio_seed_${randomUUID().replaceAll('-', '')}`;
const admin = new pg.Client({ connectionString: process.env.MIGRATION_DATABASE_URL });
let runtime: pg.Pool;
let server: import('http').Server;
let base: string;
const window = 'from=2026-09-01T00:00:00Z&to=2026-09-08T00:00:00Z';

before(async () => {
  assert.ok(process.env.MIGRATION_DATABASE_URL && process.env.DATABASE_URL, 'Run npm run setup and npm run infra:up first');
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  function url(value: string) { const parsed = new URL(value); parsed.pathname = `/${name}`; return parsed.href; }
  await runMigrations(new pg.Client({ connectionString: url(process.env.MIGRATION_DATABASE_URL!) }), new URL('../migrations/', import.meta.url).pathname);
  const seeder = new pg.Client({ connectionString: url(process.env.MIGRATION_DATABASE_URL!) });
  await seeder.connect();
  try {
    await applySeeds(seeder);
    await applySeeds(seeder);
  } finally { await seeder.end(); }
  runtime = new pg.Pool({ connectionString: url(process.env.DATABASE_URL!) });
  server = createApp({ invites: loadInviteConfig({}), postgres: runtime, redis: { ping: async () => 'PONG' } }, 'http://localhost:5173').listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/metrics`;
});

after(async () => {
  if (server) await new Promise<void>(resolve => server.close(() => resolve()));
  await runtime?.end();
  await admin.query(`DROP DATABASE IF EXISTS ${name}`);
  await admin.end();
});

async function report(path: string) {
  const response = await fetch(`${base}${path}`);
  assert.equal(response.status, 200);
  return (await response.json()).data;
}

test('seeded summary: consistent integrity, reliability telemetry and no live data', async () => {
  const summary = await report(`/summary?${window}&includeTest=true`);
  // 13 seeded activities across all seed files, every counter reconciled.
  assert.equal(summary.integrity.activitiesChecked, 13);
  assert.equal(summary.integrity.violatingActivities, 0);
  assert.deepEqual(summary.integrity.violations, []);
  assert.deepEqual(summary.bookings.rawOutcomes, { committed: 1, replay: 1, soldOut: 1, invalid: 1, technicalError: 2, total: 6 });
  assert.equal(summary.bookings.attempts, 2);
  assert.equal(summary.bookings.distinctIntents, 4);
  assert.equal(summary.bookings.retriedIntents, 1);
  assert.deepEqual(summary.bookings.excludedIntents, { replayOnly: 0, soldOut: 1, invalid: 1 });
  assert.deepEqual([summary.bookings.reliability.succeeded, summary.bookings.reliability.eligibleFailures, summary.bookings.reliability.unknownFailures], [1, 0, 1]);
  assert.equal(summary.bookings.reliability.eligibleRate, 1);
  assert.equal(summary.bookings.reliability.unknownInclusiveRate, 0.5);
  assert.equal(summary.live.status, 'no_data');
});

test('seeded product report matches the documented demonstration', async () => {
  const product = await report(`/product?${window}&includeTest=true`);
  const bookers = product.bookersInvite;
  assert.deepEqual([bookers.mature.qualifyingBookers, bookers.mature.invitedWithin24h], [7, 1]);
  assert.deepEqual(bookers.mature.bySignupGeneration, { 0: { qualifyingBookers: 5, invitedWithin24h: 0 }, 1: { qualifyingBookers: 2, invitedWithin24h: 1 } });
  assert.equal(bookers.hostCreatorsWithoutBooking, 1);
  const opens = product.openToClaim;
  assert.deepEqual([opens.headline.openedJourneys, opens.headline.convertedJourneys], [7, 3]);
  assert.deepEqual([opens.eligible.eligibleOpens, opens.eligible.converted], [6, 3]);
  assert.deepEqual(opens.reasons, { byDisplayedState: { valid: { opened: 6, converted: 3 }, expired: { opened: 1, converted: 0 } }, recoveryOpens: 1 });
  assert.deepEqual(opens.byRail, { public: { opened: 5, converted: 2 }, vouch: { opened: 1, converted: 1 } });
  assert.deepEqual(opens.byPlatform, { mobile: { opened: 3, converted: 1 }, web: { opened: 3, converted: 2 } });
  assert.deepEqual(opens.byInviterGeneration, { 0: { opened: 5, converted: 3 }, 1: { opened: 1, converted: 0 } });
  assert.deepEqual(opens.byViewer, { new: { opened: 5, converted: 2 }, returning: { opened: 1, converted: 1 } });
  const k = product.kFactor;
  assert.equal(k.cohort.size, 2);
  assert.deepEqual(k.byRail, { vouch: { acquired: 1, activated: 1, k: 0.5, activatedK: 0.5 }, public: { acquired: 2, activated: 1, k: 1, activatedK: 0.5 } });
  assert.deepEqual(k.newUsersByGeneration, [{ generation: 1, users: 3 }, { generation: 2, users: 1 }]);
  assert.equal(k.status, 'observed');
  const holdout = product.holdout.byVersion.find((version: { version: string }) => version.version === 'seed-metrics-holdout');
  assert.deepEqual(holdout.treatment, { activities: 1, participants: 2, formedPlans: 1, meanParticipantsPerActivity: 2, formedPlanRate: 1 });
  assert.deepEqual(holdout.control, { activities: 2, participants: 1, formedPlans: 0, meanParticipantsPerActivity: 0.5, formedPlanRate: 0 });
  assert.deepEqual(holdout.difference, { participantsPerActivity: 1.5, participantsPerActivityCi95: null, formedPlanRate: 1 });
  assert.equal(product.holdout.byVersion.length, 1);
});

test('the default view of the seeded window is empty except global integrity', async () => {
  const summary = await report(`/summary?${window}`);
  assert.equal(summary.bookings.reliability.status, 'no_data');
  assert.equal(summary.live.status, 'no_data');
  assert.equal(summary.integrity.activitiesChecked, 13);
  const product = await report(`/product?${window}`);
  assert.equal(product.bookersInvite.status, 'no_data');
  assert.equal(product.openToClaim.status, 'no_data');
  assert.equal(product.kFactor.status, 'no_data');
  assert.deepEqual(product.holdout.byVersion, []);
});
