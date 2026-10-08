import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { before, after, test } from 'node:test';
import { runMigrations } from '../src/migrations.js';

const name = `velio_test_${randomUUID().replaceAll('-', '')}`;
const admin = new pg.Client({ connectionString: process.env.MIGRATION_DATABASE_URL });
let owner: pg.Pool;
let runtime: pg.Pool;
before(async () => {
  assert.ok(process.env.MIGRATION_DATABASE_URL && process.env.DATABASE_URL, 'Run npm run setup and npm run infra:up first');
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  function url(value: string) { const url = new URL(value); url.pathname = `/${name}`; return url.href; }
  const migrationUrl = url(process.env.MIGRATION_DATABASE_URL!);
  await runMigrations(new pg.Client({ connectionString: migrationUrl }), new URL('../migrations/', import.meta.url).pathname);
  owner = new pg.Pool({ connectionString: migrationUrl });
  runtime = new pg.Pool({ connectionString: url(process.env.DATABASE_URL!) });
});
after(async () => {
  await runtime?.end(); await owner?.end();
  await admin.query(`DROP DATABASE IF EXISTS ${name}`);
  await admin.end();
});

test('reconciliation uses an activity-leading index across representative unrelated booking history', async () => {
  const indexes = (await owner.query("SELECT indexname,indexdef FROM pg_indexes WHERE tablename='bookings'")).rows;
  assert.ok(indexes.some(index => index.indexname === 'bookings_activity_id_idx'), JSON.stringify(indexes));
  const users = (await owner.query(`WITH identities AS (SELECT gen_random_uuid() AS id FROM generate_series(1,200))
    INSERT INTO users (id,display_name,generation,acquisition_root_id,synthetic,test)
    SELECT id,'Synthetic query-plan actor',0,id,true,true FROM identities RETURNING id`)).rows.map(row => row.id);
  const activities = (await owner.query(`INSERT INTO activities
    (host_id,title,description,meeting_location,starts_at,timezone,capacity,confirmed_count,price_minor,currency)
    SELECT $1,'Synthetic history','Reconciliation plan measurement','Test gate','2030-01-15','UTC',200,200,0,'NGN'
    FROM generate_series(1,500) RETURNING id`, [users[0]])).rows.map(row => row.id);
  await owner.query(`INSERT INTO bookings (activity_id,plan_id,user_id,price_minor,currency)
    SELECT a.id,p.id,u.id,0,'NGN' FROM activities a JOIN plans p ON p.activity_id=a.id CROSS JOIN users u
    WHERE a.id=ANY($1::uuid[]) AND u.id=ANY($2::uuid[])`, [activities, users]);
  await owner.query('VACUUM ANALYZE bookings');
  await owner.query('ANALYZE activities');
  const query = 'EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) SELECT counter_mismatch,oversold FROM booking_reconciliation WHERE activity_id=$1';
  const connection = await owner.connect();
  let beforePlan;
  try {
    await connection.query('BEGIN');
    await connection.query('DROP INDEX bookings_activity_id_idx');
    beforePlan = (await connection.query(query, [activities[0]])).rows[0]['QUERY PLAN'][0];
  } finally { await connection.query('ROLLBACK'); connection.release(); }
  const afterPlan = (await owner.query(query, [activities[0]])).rows[0]['QUERY PLAN'][0];
  function nodes(plan: Record<string, unknown>): Record<string, unknown>[] {
    return [plan, ...((plan.Plans ?? []) as Record<string, unknown>[]).flatMap(nodes)];
  }
  const beforeNodes = nodes(beforePlan.Plan);
  const afterNodes = nodes(afterPlan.Plan);
  assert.ok(beforeNodes.some(node => node['Relation Name'] === 'bookings' && node['Node Type'] === 'Seq Scan'));
  assert.ok(afterNodes.some(node => node['Index Name'] === 'bookings_activity_id_idx'));
  const state = (await runtime.query('SELECT * FROM booking_reconciliation WHERE activity_id=$1', [activities[0]])).rows[0];
  assert.equal(state.booking_count, 200);
  assert.equal(state.counter_mismatch, false);
  assert.equal(state.oversold, false);
  console.log('Representative reconciliation plans:', JSON.stringify({ dataset: { activities: 500, bookings: 100000, targetBookings: 200 },
    before: beforePlan, after: afterPlan }));
});
