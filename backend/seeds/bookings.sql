BEGIN;
INSERT INTO activities (id,host_id,title,description,meeting_location,starts_at,timezone,status,capacity,price_minor,currency)
VALUES
  ('b3000000-0000-4000-8000-000000000001','a1000000-0000-4000-8000-000000000001','Started walk · demo seed',
   'Synthetic started activity. New bookings are rejected.', 'Marina gate, Lagos','2020-01-15T07:00:00Z','Africa/Lagos','scheduled',2,1500,'NGN'),
  ('b3000000-0000-4000-8000-000000000002','a1000000-0000-4000-8000-000000000001','Cancelled picnic · demo seed',
   'Synthetic cancelled activity. New bookings are rejected.', 'Marina gate, Lagos','2030-01-15T07:00:00Z','Africa/Lagos','cancelled',2,0,'NGN')
ON CONFLICT (id) DO NOTHING;
COMMIT;
