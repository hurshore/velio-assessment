-- Labelled product-metric fixtures for manual inspection (requires host.sql conventions:
-- migration credentials, idempotent inserts). Everything is synthetic, so the default
-- includeTest=false view stays empty; query with includeTest=true and the historical
-- window 2026-10-01T00:00:00Z..2026-10-08T00:00:00Z to reproduce:
--   GET /api/metrics/summary?from=2026-10-01T00:00:00Z&to=2026-10-08T00:00:00Z&includeTest=true
--   GET /api/metrics/product?from=2026-10-01T00:00:00Z&to=2026-10-08T00:00:00Z&includeTest=true
-- Hand-calculated expectations live in backend/test/metrics.test.ts, which verifies the
-- same scenarios against these definitions on an isolated database.
BEGIN;

INSERT INTO users (id, display_name, generation, acquisition_root_id, synthetic, created_at)
VALUES ('a7000000-0000-4000-8000-000000000001', 'Metrics seed host', 0, 'a7000000-0000-4000-8000-000000000001', true, '2026-09-20T09:00:00Z'),
       ('a7000000-0000-4000-8000-000000000002', 'Metrics seed cohort booker', 0, 'a7000000-0000-4000-8000-000000000002', true, '2026-09-25T09:00:00Z')
ON CONFLICT (id) DO NOTHING;
INSERT INTO signup_attribution (user_id, generation, root_id, created_at)
SELECT id, generation, acquisition_root_id, created_at FROM users WHERE id::text LIKE 'a7000000-%'
ON CONFLICT (user_id) DO NOTHING;

-- Booking outcomes (reliability): an eligible retry that commits, an eligible failure, an
-- unknown failure, a sold-out rejection, an invalid request, and a replay.
INSERT INTO analytics_events (id, schema_version, name, occurred_at, source, platform, actor_id, context, synthetic)
VALUES
  ('f7000000-0000-4000-8000-000000000001', 1, 'booking_request_outcome', '2026-10-02T09:59:30Z', 'server', 'web', 'a7000000-0000-4000-8000-000000000002', '{"seedScenario":"metrics-reliability","outcome":"technical_error","eligibility":"eligible","operation":"book_activity"}', true),
  ('f7000000-0000-4000-8000-000000000002', 1, 'booking_request_outcome', '2026-10-02T10:00:30Z', 'server', 'web', 'a7000000-0000-4000-8000-000000000002', '{"seedScenario":"metrics-reliability","outcome":"committed","eligibility":"eligible","operation":"book_activity"}', true),
  ('f7000000-0000-4000-8000-000000000003', 1, 'booking_request_outcome', '2026-10-03T10:00:00Z', 'server', 'web', 'a7000000-0000-4000-8000-000000000002', '{"seedScenario":"metrics-reliability","outcome":"technical_error","eligibility":"unknown","operation":"book_activity"}', true),
  ('f7000000-0000-4000-8000-000000000004', 1, 'booking_request_outcome', '2026-10-03T12:00:00Z', 'server', 'web', 'a7000000-0000-4000-8000-000000000002', '{"seedScenario":"metrics-reliability","outcome":"sold_out","eligibility":"sold_out","operation":"book_activity"}', true),
  ('f7000000-0000-4000-8000-000000000005', 1, 'booking_request_outcome', '2026-10-03T13:00:00Z', 'server', 'web', 'a7000000-0000-4000-8000-000000000002', '{"seedScenario":"metrics-reliability","outcome":"invalid","eligibility":"ineligible","operation":"book_activity"}', true),
  ('f7000000-0000-4000-8000-000000000006', 1, 'booking_request_outcome', '2026-10-04T10:00:00Z', 'server', 'web', 'a7000000-0000-4000-8000-000000000002', '{"seedScenario":"metrics-reliability","outcome":"replay","eligibility":"replay","operation":"book_activity"}', true)
ON CONFLICT (id) DO NOTHING;

-- Funnel activities: act2 starts inside the window to exercise the activity-start deadline.
INSERT INTO activities (id, host_id, title, description, meeting_location, starts_at, timezone, capacity, price_minor, currency, created_at)
VALUES
  ('b7000000-0000-4000-8000-000000000002', 'a7000000-0000-4000-8000-000000000001', 'Metrics funnel · demo seed', 'Synthetic funnel fixture with valid, full, recovery and boundary opens.', 'Seed gate', '2030-01-01T09:00:00Z', 'UTC', 20, 0, 'NGN', '2026-09-30T10:00:00Z'),
  ('b7000000-0000-4000-8000-000000000005', 'a7000000-0000-4000-8000-000000000001', 'Metrics started · demo seed', 'Synthetic started-boundary fixture; its claim arrives after activity start.', 'Seed gate', '2026-10-05T12:00:00Z', 'UTC', 20, 0, 'NGN', '2026-09-30T10:00:00Z')
ON CONFLICT (id) DO NOTHING;
SELECT assign_invite_experiment('b7000000-0000-4000-8000-000000000002','seed-metrics',50);
SELECT assign_invite_experiment('b7000000-0000-4000-8000-000000000005','seed-metrics',100);
UPDATE experiment_assignments SET assigned_at='2026-09-30T10:00:00Z' WHERE activity_id::text LIKE 'b7000000-%';

-- Public invite + vouch on the funnel activity, created by the host.
INSERT INTO invites (id, code, activity_id, plan_id, inviter_id, inviter_role, rail, inviter_generation, inviter_parent_id, inviter_root_id, invitee_generation, created_at, expires_at)
SELECT 'c7000000-0000-4000-8000-000000000001', 'METR1CS0001X', p.activity_id, p.id, 'a7000000-0000-4000-8000-000000000001', 'host', 'public',
  0, NULL, 'a7000000-0000-4000-8000-000000000001', 1, '2026-10-01T09:00:00Z', '2026-10-02T09:00:00Z'
FROM plans p WHERE p.activity_id='b7000000-0000-4000-8000-000000000002'
ON CONFLICT (id) DO NOTHING;
INSERT INTO invites (id, code, activity_id, plan_id, inviter_id, inviter_role, rail, recipient_contact, inviter_generation, inviter_parent_id, inviter_root_id, invitee_generation, created_at, expires_at)
SELECT 'c7000000-0000-4000-8000-000000000002', 'METR1CS0002X', p.activity_id, p.id, 'a7000000-0000-4000-8000-000000000001', 'host', 'vouch', 'metrics-vouch@example.com',
  0, NULL, 'a7000000-0000-4000-8000-000000000001', 1, '2026-10-04T07:00:00Z', '2026-10-05T07:00:00Z'
FROM plans p WHERE p.activity_id='b7000000-0000-4000-8000-000000000002'
ON CONFLICT (id) DO NOTHING;
INSERT INTO invites (id, code, activity_id, plan_id, inviter_id, inviter_role, rail, inviter_generation, inviter_parent_id, inviter_root_id, invitee_generation, created_at, expires_at)
SELECT 'c7000000-0000-4000-8000-000000000003', 'METR1CS0003X', p.activity_id, p.id, 'a7000000-0000-4000-8000-000000000001', 'host', 'public',
  0, NULL, 'a7000000-0000-4000-8000-000000000001', 1, '2026-10-04T18:00:00Z', '2026-10-05T12:00:00Z'
FROM plans p WHERE p.activity_id='b7000000-0000-4000-8000-000000000005'
ON CONFLICT (id) DO NOTHING;

-- Acquired guests: one vouch signup who claims, one public signup who never books, one
-- public signup on the started-boundary journey whose claim misses the deadline.
INSERT INTO users (id, display_name, contact, generation, acquisition_parent_id, acquisition_root_id, acquisition_invite_id, acquisition_rail, synthetic, created_at)
VALUES
  ('a7000000-0000-4000-8000-000000000011', 'Metrics seed vouch guest', 'metrics-vouch@example.com', 1, 'a7000000-0000-4000-8000-000000000001', 'a7000000-0000-4000-8000-000000000001', 'c7000000-0000-4000-8000-000000000002', 'vouch', true, '2026-10-04T10:30:00Z'),
  ('a7000000-0000-4000-8000-000000000012', 'Metrics seed public guest', NULL, 1, 'a7000000-0000-4000-8000-000000000001', 'a7000000-0000-4000-8000-000000000001', 'c7000000-0000-4000-8000-000000000001', 'public', true, '2026-10-02T08:45:00Z'),
  ('a7000000-0000-4000-8000-000000000013', 'Metrics seed started guest', NULL, 1, 'a7000000-0000-4000-8000-000000000001', 'a7000000-0000-4000-8000-000000000001', 'c7000000-0000-4000-8000-000000000003', 'public', true, '2026-10-05T12:00:00Z')
ON CONFLICT (id) DO NOTHING;
INSERT INTO signup_attribution (user_id, generation, parent_id, root_id, invite_id, rail, created_at)
SELECT id, generation, acquisition_parent_id, acquisition_root_id, acquisition_invite_id, acquisition_rail, created_at FROM users
WHERE id IN ('a7000000-0000-4000-8000-000000000011','a7000000-0000-4000-8000-000000000012','a7000000-0000-4000-8000-000000000013')
ON CONFLICT (user_id) DO NOTHING;

INSERT INTO bookings (id, activity_id, plan_id, user_id, price_minor, currency, confirmed_at)
SELECT b.id::uuid, p.activity_id, p.id, b.user_id::uuid, 0, 'NGN', b.confirmed_at::timestamptz
FROM plans p, (VALUES
  ('d7000000-0000-4000-8000-000000000001','a7000000-0000-4000-8000-000000000011','2026-10-05T06:00:00Z','b7000000-0000-4000-8000-000000000002'),
  ('d7000000-0000-4000-8000-000000000002','a7000000-0000-4000-8000-000000000012','2026-10-02T08:50:00Z','b7000000-0000-4000-8000-000000000002'),
  ('d7000000-0000-4000-8000-000000000003','a7000000-0000-4000-8000-000000000013','2026-10-05T12:30:00Z','b7000000-0000-4000-8000-000000000005')
) AS b(id, user_id, confirmed_at, activity_id)
WHERE p.activity_id=b.activity_id::uuid
ON CONFLICT (id) DO NOTHING;
UPDATE activities a SET confirmed_count = (SELECT count(*) FROM bookings b WHERE b.activity_id=a.id) WHERE a.id::text LIKE 'b7000000-%';

INSERT INTO invite_redemptions (id, invite_id, activity_id, inviter_id, rail, invitee_id, invitee_generation, booking_id, created_at)
SELECT r.id::uuid, i.id, i.activity_id, i.inviter_id, i.rail, r.user_id::uuid, u.generation, r.booking_id::uuid, r.created_at::timestamptz
FROM (VALUES
  ('e7000000-0000-4000-8000-000000000001','c7000000-0000-4000-8000-000000000002','a7000000-0000-4000-8000-000000000011','d7000000-0000-4000-8000-000000000001','2026-10-05T06:00:00Z'),
  ('e7000000-0000-4000-8000-000000000002','c7000000-0000-4000-8000-000000000001','a7000000-0000-4000-8000-000000000012','d7000000-0000-4000-8000-000000000002','2026-10-02T08:50:00Z'),
  ('e7000000-0000-4000-8000-000000000003','c7000000-0000-4000-8000-000000000003','a7000000-0000-4000-8000-000000000013','d7000000-0000-4000-8000-000000000003','2026-10-05T12:30:00Z')
) AS r(id, invite_id, user_id, booking_id, created_at)
JOIN invites i ON i.id=r.invite_id::uuid JOIN users u ON u.id=r.user_id::uuid
ON CONFLICT (id) DO NOTHING;

-- Open journeys: a repeated open that converts, a full-preview open, a recovery reopen by an
-- existing booker, an unconverted valid open, and the started-boundary journey.
INSERT INTO analytics_events (id, schema_version, name, occurred_at, source, platform, actor_id, journey_id, invite_id, context, synthetic)
SELECT ev.id::uuid, 1, ev.name, ev.occurred_at::timestamptz, 'client', ev.platform, ev.actor_id::uuid, ev.journey_id::uuid, ev.invite_id::uuid,
  ev.context::jsonb || jsonb_build_object('seedScenario','metrics-funnel'), true
FROM (VALUES
  ('f7000000-0000-4000-8000-000000000011','invite_opened','2026-10-02T08:00:00Z','mobile',NULL,'a7700000-0000-4000-8000-000000000001','c7000000-0000-4000-8000-000000000001','{"rail":"public","displayedState":"valid","stateAtReceipt":"valid","recovery":false}'),
  ('f7000000-0000-4000-8000-000000000012','invite_opened','2026-10-02T08:30:00Z','mobile',NULL,'a7700000-0000-4000-8000-000000000001','c7000000-0000-4000-8000-000000000001','{"rail":"public","displayedState":"valid","stateAtReceipt":"valid","recovery":false}'),
  ('f7000000-0000-4000-8000-000000000013','spot_claimed','2026-10-02T08:50:00Z','mobile','a7000000-0000-4000-8000-000000000012','a7700000-0000-4000-8000-000000000001','c7000000-0000-4000-8000-000000000001','{"rail":"public","outcome":"committed"}'),
  ('f7000000-0000-4000-8000-000000000014','invite_opened','2026-10-03T11:00:00Z','mobile',NULL,'a7700000-0000-4000-8000-000000000002','c7000000-0000-4000-8000-000000000001','{"rail":"public","displayedState":"full","stateAtReceipt":"full","recovery":false}'),
  ('f7000000-0000-4000-8000-000000000015','invite_opened','2026-10-04T09:00:00Z','web','a7000000-0000-4000-8000-000000000012','a7700000-0000-4000-8000-000000000003','c7000000-0000-4000-8000-000000000001','{"rail":"public","displayedState":"valid","stateAtReceipt":"valid","recovery":true}'),
  ('f7000000-0000-4000-8000-000000000016','invite_opened','2026-10-03T10:00:00Z','web',NULL,'a7700000-0000-4000-8000-000000000004','c7000000-0000-4000-8000-000000000001','{"rail":"public","displayedState":"valid","stateAtReceipt":"valid","recovery":false}'),
  ('f7000000-0000-4000-8000-000000000017','invite_opened','2026-10-04T10:00:00Z','web',NULL,'a7700000-0000-4000-8000-000000000005','c7000000-0000-4000-8000-000000000002','{"rail":"vouch","displayedState":"valid","stateAtReceipt":"valid","recovery":false}'),
  ('f7000000-0000-4000-8000-000000000018','spot_claimed','2026-10-05T06:00:00Z','web','a7000000-0000-4000-8000-000000000011','a7700000-0000-4000-8000-000000000005','c7000000-0000-4000-8000-000000000002','{"rail":"vouch","outcome":"committed"}'),
  ('f7000000-0000-4000-8000-000000000019','invite_opened','2026-10-04T20:00:00Z','mobile',NULL,'a7700000-0000-4000-8000-000000000006','c7000000-0000-4000-8000-000000000003','{"rail":"public","displayedState":"valid","stateAtReceipt":"valid","recovery":false}'),
  ('f7000000-0000-4000-8000-00000000001a','spot_claimed','2026-10-05T12:30:00Z','mobile','a7000000-0000-4000-8000-000000000013','a7700000-0000-4000-8000-000000000006','c7000000-0000-4000-8000-000000000003','{"rail":"public","outcome":"committed"}')
) AS ev(id, name, occurred_at, platform, actor_id, journey_id, invite_id, context)
ON CONFLICT (id) DO NOTHING;

-- Holdout arms under one experiment version: treatment forms a plan, control does not.
INSERT INTO activities (id, host_id, title, description, meeting_location, starts_at, timezone, capacity, price_minor, currency, created_at)
VALUES
  ('b7000000-0000-4000-8000-000000000006', 'a7000000-0000-4000-8000-000000000001', 'Metrics holdout treatment · demo seed', 'Synthetic treatment activity with two participants.', 'Seed gate', '2030-01-01T09:00:00Z', 'UTC', 20, 0, 'NGN', '2026-10-01T12:00:00Z'),
  ('b7000000-0000-4000-8000-000000000007', 'a7000000-0000-4000-8000-000000000001', 'Metrics holdout control · demo seed', 'Synthetic control activity with one participant.', 'Seed gate', '2030-01-01T09:00:00Z', 'UTC', 20, 0, 'NGN', '2026-10-01T12:00:00Z')
ON CONFLICT (id) DO NOTHING;
SELECT assign_invite_experiment(id, 'seed-metrics-holdout', 100) FROM activities WHERE id='b7000000-0000-4000-8000-000000000006';
SELECT assign_invite_experiment(id, 'seed-metrics-holdout', 0) FROM activities WHERE id='b7000000-0000-4000-8000-000000000007';
UPDATE experiment_assignments SET assigned_at='2026-10-01T12:00:00Z' WHERE activity_id IN ('b7000000-0000-4000-8000-000000000006','b7000000-0000-4000-8000-000000000007');

INSERT INTO users (id, display_name, generation, acquisition_root_id, synthetic, created_at)
VALUES ('a7000000-0000-4000-8000-000000000021', 'Metrics holdout guest one', 0, 'a7000000-0000-4000-8000-000000000021', true, '2026-09-25T09:00:00Z'),
       ('a7000000-0000-4000-8000-000000000022', 'Metrics holdout guest two', 0, 'a7000000-0000-4000-8000-000000000022', true, '2026-09-25T09:00:00Z'),
       ('a7000000-0000-4000-8000-000000000023', 'Metrics holdout guest three', 0, 'a7000000-0000-4000-8000-000000000023', true, '2026-09-25T09:00:00Z')
ON CONFLICT (id) DO NOTHING;
INSERT INTO signup_attribution (user_id, generation, root_id, created_at)
SELECT id, generation, acquisition_root_id, created_at FROM users WHERE id IN ('a7000000-0000-4000-8000-000000000021','a7000000-0000-4000-8000-000000000022','a7000000-0000-4000-8000-000000000023')
ON CONFLICT (user_id) DO NOTHING;
INSERT INTO bookings (id, activity_id, plan_id, user_id, price_minor, currency, confirmed_at)
SELECT b.id::uuid, p.activity_id, p.id, b.user_id::uuid, 0, 'NGN', '2026-10-02T10:00:00Z'
FROM plans p, (VALUES
  ('d7000000-0000-4000-8000-000000000011','a7000000-0000-4000-8000-000000000021','b7000000-0000-4000-8000-000000000006'),
  ('d7000000-0000-4000-8000-000000000012','a7000000-0000-4000-8000-000000000022','b7000000-0000-4000-8000-000000000006'),
  ('d7000000-0000-4000-8000-000000000013','a7000000-0000-4000-8000-000000000023','b7000000-0000-4000-8000-000000000007')
) AS b(id, user_id, activity_id)
WHERE p.activity_id=b.activity_id::uuid
ON CONFLICT (id) DO NOTHING;
UPDATE activities a SET confirmed_count = (SELECT count(*) FROM bookings b WHERE b.activity_id=a.id) WHERE a.id::text LIKE 'b7000000-00000000000%';
COMMIT;
