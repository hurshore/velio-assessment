CREATE TABLE idempotency_keys (
  actor_id uuid NOT NULL REFERENCES users(id),
  operation text NOT NULL,
  key text NOT NULL CHECK (length(key) BETWEEN 1 AND 128),
  fingerprint text NOT NULL,
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (actor_id, operation, key)
);
CREATE TABLE outbox_events (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  activity_id uuid NOT NULL REFERENCES activities(id),
  booking_id uuid NOT NULL UNIQUE REFERENCES bookings(id),
  version integer NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  dispatched_at timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  UNIQUE (activity_id, version)
);
-- Inspect row membership independently of the stored capacity counter.
CREATE VIEW booking_reconciliation AS
SELECT a.id AS activity_id, a.capacity, a.confirmed_count, count(b.id)::integer AS booking_count,
  count(b.id) <> a.confirmed_count AS counter_mismatch, count(b.id) > a.capacity AS oversold
FROM activities a LEFT JOIN bookings b ON b.activity_id=a.id GROUP BY a.id;
DO $$
DECLARE runtime_role text := current_setting('velio.runtime_role');
BEGIN
  EXECUTE format('GRANT INSERT ON bookings TO %I', runtime_role);
  EXECUTE format('GRANT UPDATE (confirmed_count, version) ON activities TO %I', runtime_role);
  EXECUTE format('GRANT SELECT, INSERT ON idempotency_keys, outbox_events TO %I', runtime_role);
  EXECUTE format('GRANT UPDATE (result) ON idempotency_keys TO %I', runtime_role);
  EXECUTE format('GRANT UPDATE (dispatched_at, attempts) ON outbox_events TO %I', runtime_role);
  EXECUTE format('GRANT SELECT ON booking_reconciliation TO %I', runtime_role);
END $$;
