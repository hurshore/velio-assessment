-- One row per deduplicated (invite, guest journey) human open, with the claim attribution
-- PLANS.md §4.2 defines: a journey converts when its attributed claim lands in
-- (first open, least(open + 24h, activity start)]. Repeated opens of the same
-- (invite, journey) collapse to the first; claims without a recorded open are not journeys.
CREATE VIEW metric_invite_open_units AS
WITH first_opens AS (
  SELECT DISTINCT ON (e.invite_id, e.journey_id)
    e.invite_id, e.journey_id, e.occurred_at AS opened_at, e.platform,
    e.actor_id IS NOT NULL AS actor_present,
    e.context->>'displayedState' AS displayed_state,
    COALESCE((e.context->>'recovery')::boolean, false) AS recovery,
    e.synthetic, e.test
  FROM analytics_events e
  WHERE e.name='invite_opened'
  ORDER BY e.invite_id, e.journey_id, e.occurred_at, e.id
), claims AS (
  SELECT invite_id, journey_id, min(occurred_at) AS claimed_at
  FROM analytics_events WHERE name='spot_claimed' GROUP BY invite_id, journey_id
)
SELECT f.invite_id, f.journey_id, f.opened_at, f.platform, f.actor_present, f.displayed_state,
  f.recovery, f.synthetic, f.test, i.rail, a.starts_at,
  least(f.opened_at + interval '24 hours', a.starts_at) AS claim_deadline,
  c.claimed_at,
  (c.claimed_at IS NOT NULL AND c.claimed_at >= f.opened_at
    AND c.claimed_at <= least(f.opened_at + interval '24 hours', a.starts_at)) AS converted
FROM first_opens f
JOIN invites i ON i.id=f.invite_id
JOIN activities a ON a.id=i.activity_id
LEFT JOIN claims c ON c.invite_id=f.invite_id AND c.journey_id=f.journey_id;

DO $$
DECLARE runtime_role text := current_setting('velio.runtime_role');
BEGIN
  EXECUTE format('GRANT SELECT ON metric_invite_open_units TO %I', runtime_role);
END $$;
