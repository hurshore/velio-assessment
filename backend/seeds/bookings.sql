BEGIN;
INSERT INTO activities (id,host_id,title,description,meeting_location,starts_at,timezone,status,capacity,price_minor,currency)
VALUES
  ('b3000000-0000-4000-8000-000000000001','a1000000-0000-4000-8000-000000000001','Started walk · demo seed',
   'Synthetic started activity. New bookings are rejected.', 'Marina gate, Lagos','2020-01-15T07:00:00Z','Africa/Lagos','scheduled',2,1500,'NGN'),
  ('b3000000-0000-4000-8000-000000000002','a1000000-0000-4000-8000-000000000001','Cancelled picnic · demo seed',
   'Synthetic cancelled activity. New bookings are rejected.', 'Marina gate, Lagos','2030-01-15T07:00:00Z','Africa/Lagos','cancelled',2,0,'NGN')
ON CONFLICT (id) DO NOTHING;
INSERT INTO experiment_assignments (activity_id,experiment,version,treatment_percent,bucket,variant)
SELECT id,'group_invites_v1','1',50,bucket,CASE WHEN bucket < 5000 THEN 'treatment' ELSE 'control' END
FROM (SELECT id,invite_assignment_bucket(id,'1') AS bucket FROM activities WHERE id::text LIKE 'b3000000-%') seeded
ON CONFLICT (activity_id) DO NOTHING;
COMMIT;
