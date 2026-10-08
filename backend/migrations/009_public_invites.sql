-- Composite keys let invite provenance, signup ancestry and redemption edges reference
-- the exact immutable values they snapshot, so a writer cannot pair an invite with an
-- invented inviter, rail, root or generation.
ALTER TABLE users ADD CONSTRAINT users_generation_key UNIQUE (id, generation);
ALTER TABLE users ADD CONSTRAINT users_ancestry_key UNIQUE (id, generation, acquisition_root_id);
ALTER TABLE users ADD CONSTRAINT users_parent_key UNIQUE (id, acquisition_parent_id);
ALTER TABLE bookings ADD CONSTRAINT bookings_membership_key UNIQUE (id, user_id, activity_id);

CREATE TABLE invites (
  id uuid PRIMARY KEY,
  -- Crockford base32 without ambiguous letters: opaque and practical for manual entry.
  code text NOT NULL UNIQUE CHECK (code ~ '^[0-9A-HJKMNP-TV-Z]{12}$'),
  activity_id uuid NOT NULL REFERENCES activities(id),
  plan_id uuid NOT NULL,
  inviter_id uuid NOT NULL,
  inviter_role text NOT NULL CHECK (inviter_role IN ('host', 'booker')),
  rail text NOT NULL CHECK (rail IN ('vouch', 'public')),
  -- Snapshot of the inviter's signup referral history when the invite was created.
  inviter_generation integer NOT NULL,
  inviter_parent_id uuid,
  inviter_root_id uuid NOT NULL,
  invitee_generation integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  -- #6 replaces this when recipient binding exists; until then only public links are valid.
  CONSTRAINT invites_rail_supported CHECK (rail = 'public'),
  CHECK (invitee_generation = inviter_generation + 1),
  CHECK ((inviter_generation = 0) = (inviter_parent_id IS NULL)),
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '24 hours'),
  FOREIGN KEY (plan_id, activity_id) REFERENCES plans(id, activity_id),
  FOREIGN KEY (inviter_id, inviter_generation, inviter_root_id) REFERENCES users(id, generation, acquisition_root_id),
  FOREIGN KEY (inviter_id, inviter_parent_id) REFERENCES users(id, acquisition_parent_id),
  UNIQUE (id, inviter_id, rail, inviter_root_id, invitee_generation),
  UNIQUE (id, activity_id, inviter_id, rail)
);
CREATE INDEX invites_activity_id_idx ON invites (activity_id);

-- New invited users inherit exactly the snapshotted parent/root/rail/generation of their invite.
ALTER TABLE users ADD CONSTRAINT users_acquisition_invite_fk
  FOREIGN KEY (acquisition_invite_id, acquisition_parent_id, acquisition_rail, acquisition_root_id, generation)
  REFERENCES invites(id, inviter_id, rail, inviter_root_id, invitee_generation);
ALTER TABLE signup_attribution ADD CONSTRAINT signup_attribution_invite_fk
  FOREIGN KEY (invite_id, parent_id, rail, root_id, generation)
  REFERENCES invites(id, inviter_id, rail, inviter_root_id, invitee_generation);
ALTER TABLE analytics_events ADD FOREIGN KEY (invite_id) REFERENCES invites(id);

-- A booking redemption is separate from signup acquisition: returning users keep their
-- signup history and record only this activity-level edge.
CREATE TABLE invite_redemptions (
  id uuid PRIMARY KEY,
  invite_id uuid NOT NULL,
  activity_id uuid NOT NULL,
  inviter_id uuid NOT NULL,
  rail text NOT NULL,
  invitee_id uuid NOT NULL,
  invitee_generation integer NOT NULL,
  booking_id uuid NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (invitee_id <> inviter_id),
  UNIQUE (invite_id, invitee_id),
  FOREIGN KEY (invite_id, activity_id, inviter_id, rail) REFERENCES invites(id, activity_id, inviter_id, rail),
  FOREIGN KEY (booking_id, invitee_id, activity_id) REFERENCES bookings(id, user_id, activity_id),
  FOREIGN KEY (invitee_id, invitee_generation) REFERENCES users(id, generation)
);

-- History is corrected by appending an explanation, never by rewriting the original row.
CREATE TABLE attribution_corrections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject text NOT NULL CHECK (subject IN ('signup_attribution', 'invite', 'invite_redemption')),
  subject_id uuid NOT NULL,
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 2000),
  correction jsonb NOT NULL DEFAULT '{}',
  recorded_by text NOT NULL DEFAULT current_user,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Runtime grants are the primary guard. These triggers additionally stop ordinary
-- statements from any role rewriting history; they do not defend against an
-- administrator disabling triggers or replacing the database.
CREATE FUNCTION reject_history_rewrite() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  RAISE EXCEPTION '% history is append-only; record an attribution correction instead', TG_TABLE_NAME
    USING ERRCODE = 'insufficient_privilege';
END $$;
CREATE TRIGGER invites_append_only BEFORE UPDATE OR DELETE ON invites
  FOR EACH ROW EXECUTE FUNCTION reject_history_rewrite();
CREATE TRIGGER invite_redemptions_append_only BEFORE UPDATE OR DELETE ON invite_redemptions
  FOR EACH ROW EXECUTE FUNCTION reject_history_rewrite();
CREATE TRIGGER signup_attribution_append_only BEFORE UPDATE OR DELETE ON signup_attribution
  FOR EACH ROW EXECUTE FUNCTION reject_history_rewrite();
CREATE TRIGGER attribution_corrections_append_only BEFORE UPDATE OR DELETE ON attribution_corrections
  FOR EACH ROW EXECUTE FUNCTION reject_history_rewrite();
CREATE FUNCTION reject_ancestry_rewrite() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF (NEW.generation, NEW.acquisition_parent_id, NEW.acquisition_root_id, NEW.acquisition_invite_id, NEW.acquisition_rail)
    IS DISTINCT FROM (OLD.generation, OLD.acquisition_parent_id, OLD.acquisition_root_id, OLD.acquisition_invite_id, OLD.acquisition_rail) THEN
    RAISE EXCEPTION 'Signup ancestry is immutable; record an attribution correction instead'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER users_ancestry_immutable BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION reject_ancestry_rewrite();

DO $$
DECLARE runtime_role text := current_setting('velio.runtime_role');
BEGIN
  EXECUTE format('GRANT SELECT, INSERT ON invites, invite_redemptions TO %I', runtime_role);
  EXECUTE format('GRANT SELECT ON attribution_corrections TO %I', runtime_role);
END $$;
