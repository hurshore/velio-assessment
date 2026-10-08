CREATE TABLE experiment_assignments (
  activity_id uuid PRIMARY KEY REFERENCES activities(id),
  experiment text NOT NULL CHECK (experiment = 'group_invites_v1'),
  version text NOT NULL CHECK (length(btrim(version)) BETWEEN 1 AND 100),
  treatment_percent integer NOT NULL CHECK (treatment_percent BETWEEN 0 AND 100),
  bucket integer NOT NULL CHECK (bucket BETWEEN 0 AND 9999),
  variant text NOT NULL CHECK (variant IN ('treatment', 'control')),
  assigned_at timestamptz NOT NULL DEFAULT now(),
  CHECK (variant = CASE WHEN bucket < treatment_percent * 100 THEN 'treatment' ELSE 'control' END)
);
-- A fixed hash gives each activity/version a reproducible bucket, independently of API process state.
CREATE FUNCTION invite_assignment_bucket(activity uuid, version text) RETURNS integer
LANGUAGE sql IMMUTABLE STRICT SET search_path = pg_catalog AS $$
  SELECT ((('x' || substr(md5('group_invites_v1:' || version || ':' || activity::text), 1, 8))::bit(32)::bigint) % 10000)::integer
$$;
INSERT INTO experiment_assignments (activity_id, experiment, version, treatment_percent, bucket, variant)
SELECT id, 'group_invites_v1', '1', 50, bucket, CASE WHEN bucket < 5000 THEN 'treatment' ELSE 'control' END
FROM (SELECT id, invite_assignment_bucket(id, '1') AS bucket FROM activities) existing;
DO $$
DECLARE runtime_role text := current_setting('velio.runtime_role');
BEGIN
  EXECUTE format('GRANT SELECT, INSERT ON experiment_assignments TO %I', runtime_role);
  EXECUTE format('GRANT INSERT (id) ON activities TO %I', runtime_role);
END $$;
