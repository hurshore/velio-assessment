-- 005 already backfilled the pre-experiment activities. If later writers omitted
-- assignments, fail this migration visibly so their cohort can be repaired explicitly.
-- No trigger may silently choose experiment configuration for another writer.
ALTER TABLE activities ADD CONSTRAINT activities_invite_assignment_fk
  FOREIGN KEY (id) REFERENCES experiment_assignments(activity_id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE experiment_assignments ADD CONSTRAINT invite_assignment_bucket_matches
  CHECK (bucket = invite_assignment_bucket(activity_id, version));

-- Security invoker retains runtime's narrow INSERT permissions. Existing rows are
-- never rewritten on replay; constraints independently verify both hash and variant.
CREATE FUNCTION assign_invite_experiment(activity uuid, cohort_version text, allocation integer) RETURNS uuid
LANGUAGE sql SET search_path = pg_catalog, public AS $$
  INSERT INTO public.experiment_assignments (activity_id,experiment,version,treatment_percent,bucket,variant)
  SELECT activity,'group_invites_v1',cohort_version,allocation,bucket,
    CASE WHEN bucket < allocation * 100 THEN 'treatment' ELSE 'control' END
  FROM (SELECT public.invite_assignment_bucket(activity,cohort_version) AS bucket) hashed
  ON CONFLICT (activity_id) DO NOTHING RETURNING activity_id
$$;
