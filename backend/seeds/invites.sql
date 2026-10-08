-- Attribution chain scenario (requires host.sql): organic Amara hosts and shares a public
-- link; new user Kemi signs up and claims through it (generation 1); returning organic
-- Tunde claims through the same link (redemption only); Kemi shares again and new user
-- Zainab joins at generation 2. Fixed historical timestamps keep replay stable, so these
-- links are expired fixtures for inspecting history. Create fresh links in the app to share.
-- Seed bookings set count/version directly and carry no live-update outbox rows.
BEGIN;
INSERT INTO activities (id,host_id,title,description,meeting_location,starts_at,timezone,capacity,confirmed_count,price_minor,currency,version,created_at)
VALUES ('b5000000-0000-4000-8000-000000000001','a1000000-0000-4000-8000-000000000001','Supper club · demo seed',
  'Synthetic referral-chain scenario. Seats were claimed through public links; invitations never reserved them.',
  'Courtyard, Lagos','2030-03-01T18:00:00Z','Africa/Lagos',6,3,5000,'NGN',4,'2026-10-01T08:00:00Z')
ON CONFLICT (id) DO NOTHING;
SELECT assign_invite_experiment('b5000000-0000-4000-8000-000000000001','seed-invites',100);

INSERT INTO invites (id,code,activity_id,plan_id,inviter_id,inviter_role,rail,inviter_generation,inviter_parent_id,inviter_root_id,invitee_generation,created_at,expires_at)
SELECT 'c5000000-0000-4000-8000-000000000001','SEEDAMARA001',p.activity_id,p.id,'a1000000-0000-4000-8000-000000000001','host','public',
  0,NULL,'a1000000-0000-4000-8000-000000000001',1,'2026-10-01T09:00:00Z','2026-10-02T09:00:00Z'
FROM plans p WHERE p.activity_id='b5000000-0000-4000-8000-000000000001'
ON CONFLICT (id) DO NOTHING;
INSERT INTO users (id,display_name,generation,acquisition_parent_id,acquisition_root_id,acquisition_invite_id,acquisition_rail,synthetic,created_at)
VALUES ('a1000000-0000-4000-8000-000000000003','Kemi · demo seed',1,'a1000000-0000-4000-8000-000000000001','a1000000-0000-4000-8000-000000000001',
  'c5000000-0000-4000-8000-000000000001','public',true,'2026-10-01T10:00:00Z')
ON CONFLICT (id) DO NOTHING;

INSERT INTO bookings (id,activity_id,plan_id,user_id,price_minor,currency,confirmed_at)
SELECT booking.id::uuid,p.activity_id,p.id,booking.user_id::uuid,5000,'NGN',booking.confirmed_at::timestamptz
FROM plans p, (VALUES
  ('d5000000-0000-4000-8000-000000000001','a1000000-0000-4000-8000-000000000003','2026-10-01T10:30:00Z'),
  ('d5000000-0000-4000-8000-000000000002','a1000000-0000-4000-8000-000000000002','2026-10-01T11:00:00Z')) AS booking(id,user_id,confirmed_at)
WHERE p.activity_id='b5000000-0000-4000-8000-000000000001'
ON CONFLICT (id) DO NOTHING;

INSERT INTO invites (id,code,activity_id,plan_id,inviter_id,inviter_role,rail,inviter_generation,inviter_parent_id,inviter_root_id,invitee_generation,created_at,expires_at)
SELECT 'c5000000-0000-4000-8000-000000000002','SEEDKEMYZ002',p.activity_id,p.id,'a1000000-0000-4000-8000-000000000003','booker','public',
  1,'a1000000-0000-4000-8000-000000000001','a1000000-0000-4000-8000-000000000001',2,'2026-10-01T12:00:00Z','2026-10-02T12:00:00Z'
FROM plans p WHERE p.activity_id='b5000000-0000-4000-8000-000000000001'
ON CONFLICT (id) DO NOTHING;
INSERT INTO users (id,display_name,generation,acquisition_parent_id,acquisition_root_id,acquisition_invite_id,acquisition_rail,synthetic,created_at)
VALUES ('a1000000-0000-4000-8000-000000000004','Zainab · demo seed',2,'a1000000-0000-4000-8000-000000000003','a1000000-0000-4000-8000-000000000001',
  'c5000000-0000-4000-8000-000000000002','public',true,'2026-10-01T13:00:00Z')
ON CONFLICT (id) DO NOTHING;
INSERT INTO bookings (id,activity_id,plan_id,user_id,price_minor,currency,confirmed_at)
SELECT 'd5000000-0000-4000-8000-000000000003',p.activity_id,p.id,'a1000000-0000-4000-8000-000000000004',5000,'NGN','2026-10-01T13:30:00Z'
FROM plans p WHERE p.activity_id='b5000000-0000-4000-8000-000000000001'
ON CONFLICT (id) DO NOTHING;

INSERT INTO signup_attribution (user_id,generation,parent_id,root_id,invite_id,rail,created_at)
SELECT id,generation,acquisition_parent_id,acquisition_root_id,acquisition_invite_id,acquisition_rail,created_at FROM users
WHERE id IN ('a1000000-0000-4000-8000-000000000003','a1000000-0000-4000-8000-000000000004')
ON CONFLICT (user_id) DO NOTHING;

INSERT INTO invite_redemptions (id,invite_id,activity_id,inviter_id,rail,invitee_id,invitee_generation,booking_id,created_at)
SELECT redemption.id::uuid,i.id,i.activity_id,i.inviter_id,i.rail,b.user_id,u.generation,b.id,b.confirmed_at
FROM (VALUES
  ('f5000000-0000-4000-8000-000000000001','c5000000-0000-4000-8000-000000000001','d5000000-0000-4000-8000-000000000001'),
  ('f5000000-0000-4000-8000-000000000002','c5000000-0000-4000-8000-000000000001','d5000000-0000-4000-8000-000000000002'),
  ('f5000000-0000-4000-8000-000000000003','c5000000-0000-4000-8000-000000000002','d5000000-0000-4000-8000-000000000003')) AS redemption(id,invite_id,booking_id)
JOIN invites i ON i.id=redemption.invite_id::uuid JOIN bookings b ON b.id=redemption.booking_id::uuid JOIN users u ON u.id=b.user_id
ON CONFLICT (id) DO NOTHING;

-- Journeys: Kemi e6..01, Tunde e6..02, Zainab e6..03, and an anonymous late visitor e6..04
-- who opened the first link after it expired and never claimed.
INSERT INTO analytics_events (id,schema_version,name,occurred_at,source,platform,actor_id,journey_id,activity_id,plan_id,booking_id,invite_id,context,synthetic)
SELECT event.id::uuid,1,event.name,event.occurred_at::timestamptz,event.source,event.platform,event.actor_id::uuid,event.journey_id::uuid,
  p.activity_id,p.id,event.booking_id::uuid,event.invite_id::uuid,
  event.context::jsonb || jsonb_build_object('seedScenario','attribution-chain',
    'assignment',(SELECT jsonb_build_object('experiment',e.experiment,'version',e.version,'treatmentPercent',e.treatment_percent,'variant',e.variant,'assignedAt',e.assigned_at)
      FROM experiment_assignments e WHERE e.activity_id=p.activity_id)),
  true
FROM plans p, (VALUES
  ('e5000000-0000-4000-8000-000000000001','invite_created','2026-10-01T09:00:00Z','server','web','a1000000-0000-4000-8000-000000000001',NULL,NULL,'c5000000-0000-4000-8000-000000000001',
    '{"operation":"create_invite","rail":"public","inviterRole":"host","generation":0}'),
  ('e5000000-0000-4000-8000-000000000002','invite_opened','2026-10-01T09:50:00Z','client','mobile',NULL,'e6000000-0000-4000-8000-000000000001',NULL,'c5000000-0000-4000-8000-000000000001',
    '{"rail":"public","inviterRole":"host","inviterGeneration":0,"displayedState":"valid","stateAtReceipt":"valid","recovery":false}'),
  ('e5000000-0000-4000-8000-000000000003','identity_created','2026-10-01T10:00:00Z','server','mobile','a1000000-0000-4000-8000-000000000003','e6000000-0000-4000-8000-000000000001',NULL,'c5000000-0000-4000-8000-000000000001',
    '{"generation":1,"acquisition":"invite","rail":"public","acquisitionParentId":"a1000000-0000-4000-8000-000000000001","acquisitionRootId":"a1000000-0000-4000-8000-000000000001"}'),
  ('e5000000-0000-4000-8000-000000000004','invite_claim_attempted','2026-10-01T10:30:00Z','server','mobile','a1000000-0000-4000-8000-000000000003','e6000000-0000-4000-8000-000000000001',NULL,'c5000000-0000-4000-8000-000000000001',
    '{"operation":"claim_invite","rail":"public","generation":1,"eligibility":"unknown"}'),
  ('e5000000-0000-4000-8000-000000000005','spot_claimed','2026-10-01T10:30:00Z','server','mobile','a1000000-0000-4000-8000-000000000003','e6000000-0000-4000-8000-000000000001','d5000000-0000-4000-8000-000000000001','c5000000-0000-4000-8000-000000000001',
    '{"operation":"claim_invite","rail":"public","generation":1,"inviteeGeneration":1,"outcome":"committed"}'),
  ('e5000000-0000-4000-8000-000000000006','invite_opened','2026-10-01T10:55:00Z','client','mobile','a1000000-0000-4000-8000-000000000002','e6000000-0000-4000-8000-000000000002',NULL,'c5000000-0000-4000-8000-000000000001',
    '{"rail":"public","inviterRole":"host","inviterGeneration":0,"displayedState":"valid","stateAtReceipt":"valid","recovery":false,"generation":0}'),
  ('e5000000-0000-4000-8000-000000000013','invite_claim_attempted','2026-10-01T11:00:00Z','server','mobile','a1000000-0000-4000-8000-000000000002','e6000000-0000-4000-8000-000000000002',NULL,'c5000000-0000-4000-8000-000000000001',
    '{"operation":"claim_invite","rail":"public","generation":0,"eligibility":"unknown"}'),
  ('e5000000-0000-4000-8000-000000000007','spot_claimed','2026-10-01T11:00:00Z','server','mobile','a1000000-0000-4000-8000-000000000002','e6000000-0000-4000-8000-000000000002','d5000000-0000-4000-8000-000000000002','c5000000-0000-4000-8000-000000000001',
    '{"operation":"claim_invite","rail":"public","generation":0,"inviteeGeneration":0,"outcome":"committed"}'),
  ('e5000000-0000-4000-8000-000000000008','invite_created','2026-10-01T12:00:00Z','server','web','a1000000-0000-4000-8000-000000000003',NULL,NULL,'c5000000-0000-4000-8000-000000000002',
    '{"operation":"create_invite","rail":"public","inviterRole":"booker","generation":1}'),
  ('e5000000-0000-4000-8000-000000000009','invite_opened','2026-10-01T12:50:00Z','client','mobile',NULL,'e6000000-0000-4000-8000-000000000003',NULL,'c5000000-0000-4000-8000-000000000002',
    '{"rail":"public","inviterRole":"booker","inviterGeneration":1,"displayedState":"valid","stateAtReceipt":"valid","recovery":false}'),
  ('e5000000-0000-4000-8000-000000000010','identity_created','2026-10-01T13:00:00Z','server','mobile','a1000000-0000-4000-8000-000000000004','e6000000-0000-4000-8000-000000000003',NULL,'c5000000-0000-4000-8000-000000000002',
    '{"generation":2,"acquisition":"invite","rail":"public","acquisitionParentId":"a1000000-0000-4000-8000-000000000003","acquisitionRootId":"a1000000-0000-4000-8000-000000000001"}'),
  ('e5000000-0000-4000-8000-000000000014','invite_claim_attempted','2026-10-01T13:30:00Z','server','mobile','a1000000-0000-4000-8000-000000000004','e6000000-0000-4000-8000-000000000003',NULL,'c5000000-0000-4000-8000-000000000002',
    '{"operation":"claim_invite","rail":"public","generation":2,"eligibility":"unknown"}'),
  ('e5000000-0000-4000-8000-000000000011','spot_claimed','2026-10-01T13:30:00Z','server','mobile','a1000000-0000-4000-8000-000000000004','e6000000-0000-4000-8000-000000000003','d5000000-0000-4000-8000-000000000003','c5000000-0000-4000-8000-000000000002',
    '{"operation":"claim_invite","rail":"public","generation":2,"inviteeGeneration":2,"outcome":"committed"}'),
  ('e5000000-0000-4000-8000-000000000012','invite_opened','2026-10-03T09:00:00Z','client','web',NULL,'e6000000-0000-4000-8000-000000000004',NULL,'c5000000-0000-4000-8000-000000000001',
    '{"rail":"public","inviterRole":"host","inviterGeneration":0,"displayedState":"expired","stateAtReceipt":"expired","recovery":false}')
) AS event(id,name,occurred_at,source,platform,actor_id,journey_id,booking_id,invite_id,context)
WHERE p.activity_id='b5000000-0000-4000-8000-000000000001'
ON CONFLICT (id) DO NOTHING;
COMMIT;
