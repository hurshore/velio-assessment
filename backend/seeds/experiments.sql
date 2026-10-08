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
SELECT assign_invite_experiment(id,'seed-3',50) FROM activities
WHERE id::text LIKE 'b4000000-%';
COMMIT;
