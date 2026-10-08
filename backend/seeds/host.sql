BEGIN;
INSERT INTO users (id, display_name, generation, acquisition_root_id, synthetic)
VALUES ('a1000000-0000-4000-8000-000000000001', 'Amara · demo seed', 0, 'a1000000-0000-4000-8000-000000000001', true),
       ('a1000000-0000-4000-8000-000000000002', 'Tunde · demo seed', 0, 'a1000000-0000-4000-8000-000000000002', true)
ON CONFLICT (id) DO NOTHING;
INSERT INTO signup_attribution (user_id, generation, root_id)
SELECT id, generation, acquisition_root_id FROM users WHERE id IN ('a1000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000002')
ON CONFLICT (user_id) DO NOTHING;
INSERT INTO analytics_events (id, schema_version, name, occurred_at, source, platform, actor_id, context, synthetic)
SELECT CASE WHEN id='a1000000-0000-4000-8000-000000000001' THEN 'e1000000-0000-4000-8000-000000000001'::uuid ELSE 'e1000000-0000-4000-8000-000000000002'::uuid END,
  1, 'identity_created', created_at, 'server', 'web', id,
  jsonb_build_object('generation', generation, 'acquisitionRootId', acquisition_root_id, 'seedScenario', 'organic-host'), true
FROM users WHERE id IN ('a1000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000002')
ON CONFLICT (id) DO NOTHING;
INSERT INTO activities (id, host_id, title, description, meeting_location, starts_at, timezone, capacity, price_minor, currency)
VALUES ('b1000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000001', 'Marina walk · demo seed',
  'Synthetic paid activity. An easy morning walk with two available seats and no bookings.', 'Marina gate, Lagos', '2030-01-15T07:00:00Z', 'Africa/Lagos', 2, 1500, 'NGN'),
  ('b1000000-0000-4000-8000-000000000002', 'a1000000-0000-4000-8000-000000000002', 'Picnic · demo seed',
  'Synthetic free activity. Four available seats; hosting does not count as participation.', 'Park entrance, London', '2030-06-15T11:00:00Z', 'Europe/London', 4, 0, 'GBP')
ON CONFLICT (id) DO NOTHING;
INSERT INTO experiment_assignments (activity_id,experiment,version,treatment_percent,bucket,variant)
SELECT id,'group_invites_v1','1',50,bucket,CASE WHEN bucket < 5000 THEN 'treatment' ELSE 'control' END
FROM (SELECT id,invite_assignment_bucket(id,'1') AS bucket FROM activities WHERE id::text LIKE 'b1000000-%') seeded
ON CONFLICT (activity_id) DO NOTHING;
COMMIT;
