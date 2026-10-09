-- Labelled product-metric demonstration (synthetic, idempotent, migration credentials).
-- Window: 2026-09-01T00:00:00Z .. 2026-09-08T00:00:00Z, which no other seed touches.
-- Query with includeTest=true; the default includeTest=false view of these blocks is empty.
-- Expected results are listed in docs/verification/product-metrics.md ("Seed demonstration")
-- and asserted by backend/test/seed.test.ts. Only states the production writers can produce
-- appear here: exact-boundary, clock-skew and integrity-violation cases are test-only fixtures.
--
-- Cast: host H hosts E (earlier), F (funnel) and S (starts 09-05T12:00) and shares public link
-- IP, vouch IV and public link IS. B0 booked E before the window (cohort member) and returns
-- to claim F through IP. G1 claims through IP, then invites G4 (generation 2) through IG. G2
-- claims the vouch; G3 signs up through IS but never claims before S starts. R1-R4 carry
-- booking-outcome telemetry; P1-P3 are holdout participants.
BEGIN;

INSERT INTO users (id, display_name, contact, generation, acquisition_root_id, synthetic, created_at)
SELECT id::uuid, display_name, NULL, 0, id::uuid, true, '2026-08-20T09:00:00Z' FROM (VALUES
  ('a7000000-0000-4000-8000-000000000001', 'Metrics seed host'),
  ('a7000000-0000-4000-8000-000000000002', 'Metrics seed returning booker'),
  ('a7000000-0000-4000-8000-000000000003', 'Metrics seed retrying booker'),
  ('a7000000-0000-4000-8000-000000000004', 'Metrics seed unknown failure'),
  ('a7000000-0000-4000-8000-000000000005', 'Metrics seed sold-out request'),
  ('a7000000-0000-4000-8000-000000000006', 'Metrics seed invalid request'),
  ('a7000000-0000-4000-8000-000000000007', 'Metrics seed treatment participant one'),
  ('a7000000-0000-4000-8000-000000000008', 'Metrics seed treatment participant two'),
  ('a7000000-0000-4000-8000-000000000009', 'Metrics seed control participant')
) AS seeded(id, display_name)
ON CONFLICT (id) DO NOTHING;

-- Activities and their assignments share this transaction (deferred FK, migration 006).
-- Assignments carry their historical assignment time, so they are inserted directly.
INSERT INTO activities (id, host_id, title, description, meeting_location, starts_at, timezone, capacity, price_minor, currency, created_at)
SELECT id::uuid, 'a7000000-0000-4000-8000-000000000001', title, description, 'Seed gate', starts_at::timestamptz, 'UTC', 20, 0, 'NGN', created_at::timestamptz
FROM (VALUES
  ('b7000000-0000-4000-8000-000000000001', 'Metrics earlier · demo seed', 'Synthetic pre-window booking that places B0 in the K cohort.', '2030-01-01T09:00:00Z', '2026-08-25T10:00:00Z'),
  ('b7000000-0000-4000-8000-000000000002', 'Metrics funnel · demo seed', 'Synthetic funnel: public link, vouch and a booker invite.', '2030-01-01T09:00:00Z', '2026-08-25T10:00:00Z'),
  ('b7000000-0000-4000-8000-000000000003', 'Metrics start deadline · demo seed', 'Synthetic activity starting inside the window; its link closes at start.', '2026-09-05T12:00:00Z', '2026-08-25T10:00:00Z'),
  ('b7000000-0000-4000-8000-000000000004', 'Metrics holdout treatment · demo seed', 'Synthetic treatment activity with two participants.', '2030-01-01T09:00:00Z', '2026-09-01T12:00:00Z'),
  ('b7000000-0000-4000-8000-000000000005', 'Metrics holdout control · demo seed', 'Synthetic control activity with one participant.', '2030-01-01T09:00:00Z', '2026-09-01T12:00:00Z'),
  ('b7000000-0000-4000-8000-000000000006', 'Metrics holdout empty control · demo seed', 'Synthetic control activity nobody booked; it stays in the denominator.', '2030-01-01T09:00:00Z', '2026-09-01T12:00:00Z')
) AS seeded(id, title, description, starts_at, created_at)
ON CONFLICT (id) DO NOTHING;
INSERT INTO experiment_assignments (activity_id, experiment, version, treatment_percent, bucket, variant, assigned_at)
SELECT id::uuid, 'group_invites_v1', version, allocation, invite_assignment_bucket(id::uuid, version),
  CASE WHEN invite_assignment_bucket(id::uuid, version) < allocation * 100 THEN 'treatment' ELSE 'control' END, assigned_at::timestamptz
FROM (VALUES
  ('b7000000-0000-4000-8000-000000000001', 'seed-metrics', 100, '2026-08-25T10:00:00Z'),
  ('b7000000-0000-4000-8000-000000000002', 'seed-metrics', 100, '2026-08-25T10:00:00Z'),
  ('b7000000-0000-4000-8000-000000000003', 'seed-metrics', 100, '2026-08-25T10:00:00Z'),
  ('b7000000-0000-4000-8000-000000000004', 'seed-metrics-holdout', 100, '2026-09-01T12:00:00Z'),
  ('b7000000-0000-4000-8000-000000000005', 'seed-metrics-holdout', 0, '2026-09-01T12:00:00Z'),
  ('b7000000-0000-4000-8000-000000000006', 'seed-metrics-holdout', 0, '2026-09-01T12:00:00Z')
) AS seeded(id, version, allocation, assigned_at)
ON CONFLICT (activity_id) DO NOTHING;

INSERT INTO invites (id, code, activity_id, plan_id, inviter_id, inviter_role, rail, recipient_contact, inviter_generation, inviter_parent_id, inviter_root_id, invitee_generation, created_at, expires_at)
SELECT seeded.id::uuid, seeded.code, p.activity_id, p.id, 'a7000000-0000-4000-8000-000000000001', 'host', seeded.rail, seeded.recipient,
  0, NULL, 'a7000000-0000-4000-8000-000000000001', 1, seeded.created_at::timestamptz, seeded.expires_at::timestamptz
FROM (VALUES
  ('c7000000-0000-4000-8000-000000000001', 'METR1CS0001X', 'b7000000-0000-4000-8000-000000000002', 'public', NULL, '2026-09-01T09:00:00Z', '2026-09-02T09:00:00Z'),
  ('c7000000-0000-4000-8000-000000000002', 'METR1CS0002X', 'b7000000-0000-4000-8000-000000000002', 'vouch', 'metrics-seed-vouch@example.com', '2026-09-04T07:00:00Z', '2026-09-05T07:00:00Z'),
  ('c7000000-0000-4000-8000-000000000003', 'METR1CS0003X', 'b7000000-0000-4000-8000-000000000003', 'public', NULL, '2026-09-04T18:00:00Z', '2026-09-05T12:00:00Z')
) AS seeded(id, code, activity_id, rail, recipient, created_at, expires_at)
JOIN plans p ON p.activity_id=seeded.activity_id::uuid
ON CONFLICT (id) DO NOTHING;

INSERT INTO users (id, display_name, contact, generation, acquisition_parent_id, acquisition_root_id, acquisition_invite_id, acquisition_rail, synthetic, created_at)
VALUES
  ('a7000000-0000-4000-8000-000000000011', 'Metrics seed public guest', NULL, 1, 'a7000000-0000-4000-8000-000000000001', 'a7000000-0000-4000-8000-000000000001', 'c7000000-0000-4000-8000-000000000001', 'public', true, '2026-09-02T08:45:00Z'),
  ('a7000000-0000-4000-8000-000000000012', 'Metrics seed vouch guest', 'metrics-seed-vouch@example.com', 1, 'a7000000-0000-4000-8000-000000000001', 'a7000000-0000-4000-8000-000000000001', 'c7000000-0000-4000-8000-000000000002', 'vouch', true, '2026-09-04T10:30:00Z'),
  ('a7000000-0000-4000-8000-000000000013', 'Metrics seed unactivated guest', NULL, 1, 'a7000000-0000-4000-8000-000000000001', 'a7000000-0000-4000-8000-000000000001', 'c7000000-0000-4000-8000-000000000003', 'public', true, '2026-09-05T11:00:00Z')
ON CONFLICT (id) DO NOTHING;

-- G1's own invite (generation 1) brings in G4 at generation 2.
INSERT INTO invites (id, code, activity_id, plan_id, inviter_id, inviter_role, rail, inviter_generation, inviter_parent_id, inviter_root_id, invitee_generation, created_at, expires_at)
SELECT 'c7000000-0000-4000-8000-000000000004', 'METR1CS0004X', p.activity_id, p.id, 'a7000000-0000-4000-8000-000000000011', 'booker', 'public',
  1, 'a7000000-0000-4000-8000-000000000001', 'a7000000-0000-4000-8000-000000000001', 2, '2026-09-02T10:00:00Z', '2026-09-03T10:00:00Z'
FROM plans p WHERE p.activity_id='b7000000-0000-4000-8000-000000000002'
ON CONFLICT (id) DO NOTHING;
INSERT INTO users (id, display_name, generation, acquisition_parent_id, acquisition_root_id, acquisition_invite_id, acquisition_rail, synthetic, created_at)
VALUES ('a7000000-0000-4000-8000-000000000014', 'Metrics seed second-generation signup', 2, 'a7000000-0000-4000-8000-000000000011',
  'a7000000-0000-4000-8000-000000000001', 'c7000000-0000-4000-8000-000000000004', 'public', true, '2026-09-02T11:00:00Z')
ON CONFLICT (id) DO NOTHING;

INSERT INTO signup_attribution (user_id, generation, parent_id, root_id, invite_id, rail, created_at)
SELECT id, generation, acquisition_parent_id, acquisition_root_id, acquisition_invite_id, acquisition_rail, created_at
FROM users WHERE id::text LIKE 'a7000000-%'
ON CONFLICT (user_id) DO NOTHING;

INSERT INTO bookings (id, activity_id, plan_id, user_id, price_minor, currency, confirmed_at)
SELECT seeded.id::uuid, p.activity_id, p.id, seeded.user_id::uuid, 0, 'NGN', seeded.confirmed_at::timestamptz
FROM (VALUES
  ('d7000000-0000-4000-8000-000000000001', 'b7000000-0000-4000-8000-000000000001', 'a7000000-0000-4000-8000-000000000002', '2026-08-28T10:00:00Z'),
  ('d7000000-0000-4000-8000-000000000002', 'b7000000-0000-4000-8000-000000000002', 'a7000000-0000-4000-8000-000000000002', '2026-09-01T12:30:00Z'),
  ('d7000000-0000-4000-8000-000000000003', 'b7000000-0000-4000-8000-000000000002', 'a7000000-0000-4000-8000-000000000011', '2026-09-02T08:50:00Z'),
  ('d7000000-0000-4000-8000-000000000004', 'b7000000-0000-4000-8000-000000000002', 'a7000000-0000-4000-8000-000000000003', '2026-09-02T10:01:00Z'),
  ('d7000000-0000-4000-8000-000000000005', 'b7000000-0000-4000-8000-000000000002', 'a7000000-0000-4000-8000-000000000012', '2026-09-05T06:00:00Z'),
  ('d7000000-0000-4000-8000-000000000006', 'b7000000-0000-4000-8000-000000000004', 'a7000000-0000-4000-8000-000000000007', '2026-09-02T10:00:00Z'),
  ('d7000000-0000-4000-8000-000000000007', 'b7000000-0000-4000-8000-000000000004', 'a7000000-0000-4000-8000-000000000008', '2026-09-02T10:00:00Z'),
  ('d7000000-0000-4000-8000-000000000008', 'b7000000-0000-4000-8000-000000000005', 'a7000000-0000-4000-8000-000000000009', '2026-09-02T10:00:00Z')
) AS seeded(id, activity_id, user_id, confirmed_at)
JOIN plans p ON p.activity_id=seeded.activity_id::uuid
ON CONFLICT (id) DO NOTHING;
UPDATE activities a SET confirmed_count = (SELECT count(*) FROM bookings b WHERE b.activity_id=a.id)
WHERE a.id::text LIKE 'b7000000-%' AND a.confirmed_count <> (SELECT count(*) FROM bookings b WHERE b.activity_id=a.id);

INSERT INTO invite_redemptions (id, invite_id, activity_id, inviter_id, rail, invitee_id, invitee_generation, booking_id, created_at)
SELECT seeded.id::uuid, i.id, i.activity_id, i.inviter_id, i.rail, u.id, u.generation, seeded.booking_id::uuid, seeded.created_at::timestamptz
FROM (VALUES
  ('e7000000-0000-4000-8000-000000000001', 'c7000000-0000-4000-8000-000000000001', 'a7000000-0000-4000-8000-000000000002', 'd7000000-0000-4000-8000-000000000002', '2026-09-01T12:30:00Z'),
  ('e7000000-0000-4000-8000-000000000002', 'c7000000-0000-4000-8000-000000000001', 'a7000000-0000-4000-8000-000000000011', 'd7000000-0000-4000-8000-000000000003', '2026-09-02T08:50:00Z'),
  ('e7000000-0000-4000-8000-000000000003', 'c7000000-0000-4000-8000-000000000002', 'a7000000-0000-4000-8000-000000000012', 'd7000000-0000-4000-8000-000000000005', '2026-09-05T06:00:00Z')
) AS seeded(id, invite_id, user_id, booking_id, created_at)
JOIN invites i ON i.id=seeded.invite_id::uuid JOIN users u ON u.id=seeded.user_id::uuid
ON CONFLICT (id) DO NOTHING;

-- Events: booking-outcome telemetry for R1-R4, human invite opens and the claims they led to.
-- Opens are received when they occur here (prompt delivery).
INSERT INTO analytics_events (id, schema_version, name, occurred_at, received_at, source, platform, actor_id, journey_id, activity_id, booking_id, invite_id, context, synthetic)
SELECT seeded.id::uuid, 1, seeded.name, seeded.occurred_at::timestamptz, seeded.occurred_at::timestamptz, seeded.source, seeded.platform,
  seeded.actor_id::uuid, seeded.journey_id::uuid, NULL, seeded.booking_id::uuid, seeded.invite_id::uuid,
  seeded.context::jsonb || jsonb_build_object('seedScenario', 'metrics'), true
FROM (VALUES
  -- R1 retries an eligible technical failure into a commit, then replays it: one successful intent.
  ('f7000000-0000-4000-8000-000000000001', 'booking_attempted', '2026-09-02T09:59:00Z', 'server', 'web', 'a7000000-0000-4000-8000-000000000003', 'a7700000-0000-4000-8000-000000000031', NULL, NULL,
    '{"operation":"book_activity","activityId":"b7000000-0000-4000-8000-000000000002","eligibility":"unknown","requestId":"f7100000-0000-4000-8000-000000000001"}'),
  ('f7000000-0000-4000-8000-000000000002', 'booking_request_outcome', '2026-09-02T09:59:30Z', 'server', 'web', 'a7000000-0000-4000-8000-000000000003', 'a7700000-0000-4000-8000-000000000031', NULL, NULL,
    '{"operation":"book_activity","activityId":"b7000000-0000-4000-8000-000000000002","outcome":"technical_error","eligibility":"eligible","stage":"write","requestId":"f7100000-0000-4000-8000-000000000001"}'),
  ('f7000000-0000-4000-8000-000000000003', 'booking_attempted', '2026-09-02T10:00:50Z', 'server', 'web', 'a7000000-0000-4000-8000-000000000003', 'a7700000-0000-4000-8000-000000000031', NULL, NULL,
    '{"operation":"book_activity","activityId":"b7000000-0000-4000-8000-000000000002","eligibility":"unknown","requestId":"f7100000-0000-4000-8000-000000000002"}'),
  ('f7000000-0000-4000-8000-000000000004', 'booking_request_outcome', '2026-09-02T10:01:00Z', 'server', 'web', 'a7000000-0000-4000-8000-000000000003', 'a7700000-0000-4000-8000-000000000031', NULL, NULL,
    '{"operation":"book_activity","activityId":"b7000000-0000-4000-8000-000000000002","outcome":"committed","eligibility":"eligible","requestId":"f7100000-0000-4000-8000-000000000002"}'),
  ('f7000000-0000-4000-8000-000000000005', 'booking_request_outcome', '2026-09-04T10:00:00Z', 'server', 'web', 'a7000000-0000-4000-8000-000000000003', 'a7700000-0000-4000-8000-000000000031', NULL, NULL,
    '{"operation":"book_activity","activityId":"b7000000-0000-4000-8000-000000000002","outcome":"replay","eligibility":"replay","requestId":"f7100000-0000-4000-8000-000000000003"}'),
  -- R2 fails before capacity is known (U); R3 is sold out and R4 invalid (both excluded).
  ('f7000000-0000-4000-8000-000000000006', 'booking_request_outcome', '2026-09-03T10:00:00Z', 'server', 'web', 'a7000000-0000-4000-8000-000000000004', 'a7700000-0000-4000-8000-000000000032', NULL, NULL,
    '{"operation":"book_activity","activityId":"b7000000-0000-4000-8000-000000000002","outcome":"technical_error","eligibility":"unknown","stage":"activity_lock","requestId":"f7100000-0000-4000-8000-000000000004"}'),
  ('f7000000-0000-4000-8000-000000000007', 'booking_request_outcome', '2026-09-03T11:00:00Z', 'server', 'web', 'a7000000-0000-4000-8000-000000000005', 'a7700000-0000-4000-8000-000000000033', NULL, NULL,
    '{"operation":"book_activity","activityId":"b7000000-0000-4000-8000-000000000002","outcome":"sold_out","eligibility":"sold_out","code":"SOLD_OUT","requestId":"f7100000-0000-4000-8000-000000000005"}'),
  ('f7000000-0000-4000-8000-000000000008', 'booking_request_outcome', '2026-09-03T12:00:00Z', 'server', 'web', 'a7000000-0000-4000-8000-000000000006', 'a7700000-0000-4000-8000-000000000034', NULL, NULL,
    '{"operation":"book_activity","activityId":"b7000000-0000-4000-8000-000000000002","outcome":"invalid","eligibility":"ineligible","code":"ACTIVITY_STARTED","requestId":"f7100000-0000-4000-8000-000000000006"}'),
  -- J1: G1 opens IP twice (one unit) and claims 50 minutes after the first open.
  ('f7000000-0000-4000-8000-000000000010', 'invite_opened', '2026-09-02T08:00:00Z', 'client', 'mobile', NULL, 'a7700000-0000-4000-8000-000000000001', NULL, 'c7000000-0000-4000-8000-000000000001',
    '{"rail":"public","displayedState":"valid","stateAtReceipt":"valid","recovery":false}'),
  ('f7000000-0000-4000-8000-000000000011', 'invite_opened', '2026-09-02T08:30:00Z', 'client', 'mobile', NULL, 'a7700000-0000-4000-8000-000000000001', NULL, 'c7000000-0000-4000-8000-000000000001',
    '{"rail":"public","displayedState":"valid","stateAtReceipt":"valid","recovery":false}'),
  ('f7000000-0000-4000-8000-000000000012', 'spot_claimed', '2026-09-02T08:50:00Z', 'server', 'mobile', 'a7000000-0000-4000-8000-000000000011', 'a7700000-0000-4000-8000-000000000001', 'd7000000-0000-4000-8000-000000000003', 'c7000000-0000-4000-8000-000000000001',
    '{"operation":"claim_invite","rail":"public","outcome":"committed"}'),
  -- J2: a visitor opens IP after it expired. J3: G1 reopens IP after booking (recovery).
  ('f7000000-0000-4000-8000-000000000013', 'invite_opened', '2026-09-03T09:00:00Z', 'client', 'web', NULL, 'a7700000-0000-4000-8000-000000000002', NULL, 'c7000000-0000-4000-8000-000000000001',
    '{"rail":"public","displayedState":"expired","stateAtReceipt":"expired","recovery":false}'),
  ('f7000000-0000-4000-8000-000000000014', 'invite_opened', '2026-09-02T08:55:00Z', 'client', 'web', 'a7000000-0000-4000-8000-000000000011', 'a7700000-0000-4000-8000-000000000003', NULL, 'c7000000-0000-4000-8000-000000000001',
    '{"rail":"public","displayedState":"valid","stateAtReceipt":"valid","recovery":true}'),
  -- J4: a visitor opens IP and never claims.
  ('f7000000-0000-4000-8000-000000000015', 'invite_opened', '2026-09-01T10:00:00Z', 'client', 'web', NULL, 'a7700000-0000-4000-8000-000000000004', NULL, 'c7000000-0000-4000-8000-000000000001',
    '{"rail":"public","displayedState":"valid","stateAtReceipt":"valid","recovery":false}'),
  -- J5: G2 opens the vouch and claims 20 hours later.
  ('f7000000-0000-4000-8000-000000000016', 'invite_opened', '2026-09-04T10:00:00Z', 'client', 'web', NULL, 'a7700000-0000-4000-8000-000000000005', NULL, 'c7000000-0000-4000-8000-000000000002',
    '{"rail":"vouch","displayedState":"valid","stateAtReceipt":"valid","recovery":false}'),
  ('f7000000-0000-4000-8000-000000000017', 'spot_claimed', '2026-09-05T06:00:00Z', 'server', 'web', 'a7000000-0000-4000-8000-000000000012', 'a7700000-0000-4000-8000-000000000005', 'd7000000-0000-4000-8000-000000000005', 'c7000000-0000-4000-8000-000000000002',
    '{"operation":"claim_invite","rail":"vouch","outcome":"committed"}'),
  -- J6: G3 opens IS; its deadline is S's start (16h later), and G3 never claims.
  ('f7000000-0000-4000-8000-000000000018', 'invite_opened', '2026-09-04T20:00:00Z', 'client', 'mobile', NULL, 'a7700000-0000-4000-8000-000000000006', NULL, 'c7000000-0000-4000-8000-000000000003',
    '{"rail":"public","displayedState":"valid","stateAtReceipt":"valid","recovery":false}'),
  -- J8: returning user B0 opens IP with their identity and claims (no new signup).
  ('f7000000-0000-4000-8000-000000000019', 'invite_opened', '2026-09-01T12:00:00Z', 'client', 'web', 'a7000000-0000-4000-8000-000000000002', 'a7700000-0000-4000-8000-000000000008', NULL, 'c7000000-0000-4000-8000-000000000001',
    '{"rail":"public","displayedState":"valid","stateAtReceipt":"valid","recovery":false}'),
  ('f7000000-0000-4000-8000-00000000001a', 'spot_claimed', '2026-09-01T12:30:00Z', 'server', 'web', 'a7000000-0000-4000-8000-000000000002', 'a7700000-0000-4000-8000-000000000008', 'd7000000-0000-4000-8000-000000000002', 'c7000000-0000-4000-8000-000000000001',
    '{"operation":"claim_invite","rail":"public","outcome":"committed"}'),
  -- J9: G4 opens G1's invite (inviter generation 1) and signs up without claiming.
  ('f7000000-0000-4000-8000-00000000001b', 'invite_opened', '2026-09-02T10:30:00Z', 'client', 'mobile', NULL, 'a7700000-0000-4000-8000-000000000009', NULL, 'c7000000-0000-4000-8000-000000000004',
    '{"rail":"public","displayedState":"valid","stateAtReceipt":"valid","recovery":false}')
) AS seeded(id, name, occurred_at, source, platform, actor_id, journey_id, booking_id, invite_id, context)
ON CONFLICT (id) DO NOTHING;
COMMIT;
