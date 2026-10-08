CREATE TABLE users (
  id uuid PRIMARY KEY,
  display_name text NOT NULL CHECK (length(btrim(display_name)) BETWEEN 1 AND 100),
  generation integer NOT NULL CHECK (generation >= 0),
  acquisition_parent_id uuid REFERENCES users(id),
  acquisition_root_id uuid NOT NULL REFERENCES users(id),
  acquisition_invite_id uuid,
  acquisition_rail text CHECK (acquisition_rail IN ('vouch', 'public')),
  synthetic boolean NOT NULL DEFAULT false,
  test boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((generation = 0 AND acquisition_parent_id IS NULL AND acquisition_root_id = id
    AND acquisition_invite_id IS NULL AND acquisition_rail IS NULL) OR
    (generation > 0 AND acquisition_parent_id IS NOT NULL AND acquisition_invite_id IS NOT NULL AND acquisition_rail IS NOT NULL))
);
CREATE TABLE signup_attribution (
  user_id uuid PRIMARY KEY REFERENCES users(id),
  generation integer NOT NULL,
  parent_id uuid REFERENCES users(id),
  root_id uuid NOT NULL REFERENCES users(id),
  invite_id uuid,
  rail text CHECK (rail IN ('vouch', 'public')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE analytics_events (
  id uuid PRIMARY KEY,
  schema_version integer NOT NULL CHECK (schema_version = 1),
  name text NOT NULL,
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  source text NOT NULL CHECK (source IN ('server', 'client')),
  platform text NOT NULL CHECK (platform IN ('web', 'mobile')),
  actor_id uuid REFERENCES users(id),
  journey_id uuid,
  activity_id uuid,
  plan_id uuid,
  booking_id uuid,
  invite_id uuid,
  context jsonb NOT NULL DEFAULT '{}',
  synthetic boolean NOT NULL DEFAULT false,
  test boolean NOT NULL DEFAULT false,
  CHECK (actor_id IS NOT NULL OR journey_id IS NOT NULL)
);
DO $$
DECLARE runtime_role text := current_setting('velio.runtime_role');
BEGIN
  EXECUTE format('GRANT USAGE ON SCHEMA public TO %I', runtime_role);
  EXECUTE format('GRANT SELECT, INSERT ON users, signup_attribution, analytics_events TO %I', runtime_role);
  EXECUTE format('GRANT UPDATE (display_name) ON users TO %I', runtime_role);
END $$;
