-- Reconciliation candidates use three separately indexed ranges, never a history-wide OR.
CREATE INDEX outbox_created_id ON outbox_events (created_at, id);
CREATE INDEX outbox_origin_created ON outbox_events (origin_process_id, created_at, id);
CREATE INDEX live_observed_time ON live_observations (observed_at, event_id) WHERE timing='commit_observed';
