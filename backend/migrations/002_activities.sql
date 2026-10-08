CREATE FUNCTION valid_display_timezone(value text) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = value AND (value = 'UTC' OR value LIKE '%/%') AND value NOT LIKE 'posix/%' AND value NOT LIKE 'right/%')
$$;
CREATE TABLE activities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  host_id uuid NOT NULL REFERENCES users(id),
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 120),
  description text NOT NULL CHECK (length(btrim(description)) BETWEEN 1 AND 2000),
  meeting_location text NOT NULL CHECK (length(btrim(meeting_location)) BETWEEN 1 AND 300),
  starts_at timestamptz NOT NULL CHECK (isfinite(starts_at)),
  timezone text NOT NULL CHECK (valid_display_timezone(timezone)),
  status text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'cancelled', 'completed')),
  capacity integer NOT NULL CHECK (capacity > 0),
  confirmed_count integer NOT NULL DEFAULT 0 CHECK (confirmed_count >= 0 AND confirmed_count <= capacity),
  price_minor integer NOT NULL CHECK (price_minor >= 0),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  activity_id uuid NOT NULL UNIQUE REFERENCES activities(id),
  UNIQUE (id, activity_id)
);
-- Runtime inserts an activity only; this trigger creates its sole plan atomically.
CREATE FUNCTION create_activity_plan() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  INSERT INTO public.plans (activity_id) VALUES (NEW.id);
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION create_activity_plan() FROM PUBLIC;
CREATE TRIGGER activity_plan AFTER INSERT ON activities FOR EACH ROW EXECUTE FUNCTION create_activity_plan();
-- Membership is readable in this slice. Booking writes, attribution and count updates belong to #3.
CREATE TABLE bookings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  activity_id uuid NOT NULL REFERENCES activities(id),
  plan_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id),
  price_minor integer NOT NULL CHECK (price_minor >= 0),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  confirmed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, activity_id),
  FOREIGN KEY (plan_id, activity_id) REFERENCES plans(id, activity_id)
);
ALTER TABLE analytics_events ADD FOREIGN KEY (activity_id) REFERENCES activities(id);
ALTER TABLE analytics_events ADD FOREIGN KEY (plan_id) REFERENCES plans(id);
ALTER TABLE analytics_events ADD FOREIGN KEY (booking_id) REFERENCES bookings(id);
DO $$
DECLARE runtime_role text := current_setting('velio.runtime_role');
BEGIN
  EXECUTE format('GRANT SELECT ON activities, plans, bookings TO %I', runtime_role);
  EXECUTE format('GRANT INSERT (host_id, title, description, meeting_location, starts_at, timezone, capacity, price_minor, currency) ON activities TO %I', runtime_role);
END $$;
