-- Reconcile one activity without scanning unrelated membership while holding its seat lock.
CREATE INDEX bookings_activity_id_idx ON bookings (activity_id) INCLUDE (id);
