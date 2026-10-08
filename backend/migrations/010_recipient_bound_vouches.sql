-- Demo contact identifiers: a lowercase email address or a digits-only phone number with an
-- optional leading +. The API normalizes input to this form; matching is exact equality.
-- They are unverified, so recipient matching simulates rather than proves a contact's identity.
CREATE FUNCTION is_demo_contact(value text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT value ~ '^(\+?[0-9]{7,15}|[^\s@A-Z]+@[^\s@A-Z]+\.[^\s@A-Z]+)$' AND length(value) <= 254
$$;

-- Set at signup only: runtime UPDATE remains limited to display_name.
ALTER TABLE users ADD COLUMN contact text CHECK (is_demo_contact(contact));
CREATE UNIQUE INDEX users_contact_key ON users (contact) WHERE contact IS NOT NULL;

ALTER TABLE invites ADD COLUMN recipient_contact text CHECK (is_demo_contact(recipient_contact));
ALTER TABLE invites DROP CONSTRAINT invites_rail_supported;
ALTER TABLE invites ADD CONSTRAINT invites_vouch_recipient CHECK ((rail = 'vouch') = (recipient_contact IS NOT NULL));

-- A vouch allows one logical successful redemption. Every redemption of an invite already runs
-- under its activity's row lock; this index backs that serialization if a writer bypasses it.
CREATE UNIQUE INDEX invite_redemptions_one_vouch ON invite_redemptions (invite_id) WHERE rail = 'vouch';

-- Vouch redemptions and vouch-acquired signups must belong to the intended contact. The service
-- checks first and returns a domain error; these guards refuse any writer that skips the check.
CREATE FUNCTION require_vouch_recipient() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  vouch_id uuid;
  claimant_contact text;
BEGIN
  -- NEW has a different shape per table, so each branch reads only its own fields.
  IF TG_TABLE_NAME = 'users' THEN
    IF NEW.acquisition_rail IS DISTINCT FROM 'vouch' THEN RETURN NEW; END IF;
    vouch_id := NEW.acquisition_invite_id;
    claimant_contact := NEW.contact;
  ELSE
    IF NEW.rail IS DISTINCT FROM 'vouch' THEN RETURN NEW; END IF;
    vouch_id := NEW.invite_id;
    SELECT u.contact INTO claimant_contact FROM public.users u WHERE u.id = NEW.invitee_id;
  END IF;
  IF claimant_contact IS NULL OR claimant_contact IS DISTINCT FROM
      (SELECT i.recipient_contact FROM public.invites i WHERE i.id = vouch_id) THEN
    RAISE EXCEPTION 'Vouch % belongs to a different contact', vouch_id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER invite_redemptions_vouch_recipient BEFORE INSERT ON invite_redemptions
  FOR EACH ROW EXECUTE FUNCTION require_vouch_recipient();
CREATE TRIGGER users_vouch_recipient BEFORE INSERT ON users
  FOR EACH ROW EXECUTE FUNCTION require_vouch_recipient();
