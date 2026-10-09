-- One row per deduplicated (invite, guest journey) human open, with its attributed claim
-- (PLANS.md §4.2). Constants mirror backend/src/metric-policy.ts; a test checks they agree.
--
-- Timing policy. Open times come from client clocks and may arrive late (offline mobile
-- delivery); claims are stamped by the server. An open's effective time is its reported
-- occurrence, clamped to [invite creation, server receipt]: an open cannot precede its invite
-- or follow its own receipt, so a clock running ahead or behind is corrected only where it
-- contradicts those bounds, and a genuinely delayed upload keeps its true occurrence time.
-- A journey converts when a spot_claimed on the same invite and journey lands in
-- [effective open - 5 minutes, least(effective open + 24 hours, activity start)]. The
-- tolerance absorbs a client clock running ahead whose open was received after the claim.
-- Repeated opens collapse to the earliest effective open of the (invite, journey) pair.
CREATE VIEW metric_invite_open_units AS
WITH opens AS (
  SELECT e.id, e.invite_id, e.journey_id, e.platform, e.occurred_at, e.received_at,
    e.actor_id IS NOT NULL AS actor_present,
    e.context->>'displayedState' AS displayed_state,
    COALESCE((e.context->>'recovery')::boolean, false) AS recovery,
    e.synthetic, e.test,
    greatest(least(e.occurred_at, e.received_at), i.created_at) AS effective_at
  FROM analytics_events e JOIN invites i ON i.id=e.invite_id
  WHERE e.name='invite_opened'
), first_opens AS (
  SELECT DISTINCT ON (invite_id, journey_id) * FROM opens
  ORDER BY invite_id, journey_id, effective_at, id
)
SELECT f.invite_id, f.journey_id, f.effective_at AS opened_at, f.occurred_at AS reported_at, f.received_at,
  f.platform, f.actor_present, f.displayed_state, f.recovery, i.rail, i.inviter_generation, a.starts_at,
  least(f.effective_at + interval '24 hours', a.starts_at) AS claim_deadline,
  c.claimed_at,
  c.claimed_at IS NOT NULL AS converted,
  -- A unit is marked when its open or any claim on it came from a marked actor, host or inviter.
  f.synthetic OR COALESCE(c.synthetic, false) AS synthetic,
  f.test OR COALESCE(c.test, false) AS test
FROM first_opens f
JOIN invites i ON i.id=f.invite_id
JOIN activities a ON a.id=i.activity_id
LEFT JOIN LATERAL (
  SELECT min(cl.occurred_at) FILTER (WHERE cl.occurred_at >= f.effective_at - interval '5 minutes'
      AND cl.occurred_at <= least(f.effective_at + interval '24 hours', a.starts_at)) AS claimed_at,
    bool_or(cl.synthetic) AS synthetic, bool_or(cl.test) AS test
  FROM analytics_events cl
  WHERE cl.name='spot_claimed' AND cl.invite_id=f.invite_id AND cl.journey_id=f.journey_id
) c ON true;

-- Windowed event reads (reliability outcomes, attempts, opens) and per-journey claim lookups.
CREATE INDEX analytics_events_name_occurred ON analytics_events (name, occurred_at);
CREATE INDEX analytics_events_invite_journey ON analytics_events (invite_id, journey_id, name) WHERE invite_id IS NOT NULL;

DO $$
DECLARE runtime_role text := current_setting('velio.runtime_role');
BEGIN
  EXECUTE format('GRANT SELECT ON metric_invite_open_units TO %I', runtime_role);
END $$;
