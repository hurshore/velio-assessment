BEGIN;
INSERT INTO activities (id,host_id,title,description,meeting_location,starts_at,timezone,capacity,price_minor,currency)
VALUES ('b4000000-0000-4000-8000-000000000001','a1000000-0000-4000-8000-000000000001',
  'Invitations treatment · demo seed','Synthetic invite-enabled treatment. Invitations do not reserve seats.',
  'Marina gate, Lagos','2030-01-15T07:00:00Z','Africa/Lagos',4,0,'NGN'),
  ('b4000000-0000-4000-8000-000000000002','a1000000-0000-4000-8000-000000000001',
  'Ordinary booking control · demo seed','Synthetic holdout. Ordinary booking remains available.',
  'Marina gate, Lagos','2030-01-15T07:00:00Z','Africa/Lagos',4,0,'NGN')
ON CONFLICT (id) DO NOTHING;
-- These UUIDs hash to 1619 and 9277 in seed-3, giving one of each variant at 50%.
INSERT INTO experiment_assignments (activity_id,experiment,version,treatment_percent,bucket,variant)
SELECT id,'group_invites_v1','seed-3',50,bucket,CASE WHEN bucket < 5000 THEN 'treatment' ELSE 'control' END
FROM (SELECT id,invite_assignment_bucket(id,'seed-3') AS bucket FROM activities
  WHERE id IN ('b4000000-0000-4000-8000-000000000001','b4000000-0000-4000-8000-000000000002')) seeded
ON CONFLICT (activity_id) DO NOTHING;
COMMIT;
