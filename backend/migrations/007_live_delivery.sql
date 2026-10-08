CREATE TABLE live_processes (
  process_id uuid PRIMARY KEY,
  started_at timestamptz NOT NULL,
  stopped_at timestamptz
);
ALTER TABLE outbox_events ADD COLUMN origin_process_id uuid;
ALTER TABLE outbox_events ADD COLUMN lease_until timestamptz;
ALTER TABLE outbox_events ADD COLUMN retry_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX outbox_pending ON outbox_events (retry_at) WHERE dispatched_at IS NULL;
CREATE TABLE live_observations (
  event_id uuid NOT NULL REFERENCES outbox_events(id),
  process_id uuid NOT NULL,
  timing text NOT NULL CHECK (timing IN ('commit_observed','pre_commit_proxy')),
  observed_at timestamptz NOT NULL,
  started_clock double precision NOT NULL,
  expected integer NOT NULL CHECK (expected >= 0),
  PRIMARY KEY (event_id, process_id)
);
CREATE TABLE live_deliveries (
  event_id uuid NOT NULL,
  process_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  client_id uuid NOT NULL,
  deadline timestamptz NOT NULL,
  ack_at timestamptz,
  sent_version integer,
  delay_ms double precision CHECK (delay_ms >= 0),
  PRIMARY KEY (event_id, process_id, connection_id),
  FOREIGN KEY (event_id, process_id) REFERENCES live_observations(event_id, process_id)
);
DO $$
DECLARE runtime_role text := current_setting('velio.runtime_role');
BEGIN
  EXECUTE format('GRANT UPDATE (lease_until, retry_at) ON outbox_events TO %I', runtime_role);
  EXECUTE format('GRANT SELECT, INSERT ON live_processes TO %I', runtime_role);
  EXECUTE format('GRANT UPDATE (stopped_at) ON live_processes TO %I', runtime_role);
  EXECUTE format('GRANT SELECT, INSERT ON live_observations, live_deliveries TO %I', runtime_role);
  EXECUTE format('GRANT UPDATE (ack_at, delay_ms, sent_version) ON live_deliveries TO %I', runtime_role);
END $$;
