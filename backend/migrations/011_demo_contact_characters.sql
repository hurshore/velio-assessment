-- 010's check relied on locale-dependent \s, so the API and database could disagree on
-- characters such as U+0085 and turn a bad contact into a 500. Both sides now exclude the same
-- explicit code points: C0/C1 controls, space and no-break spaces, Unicode space separators,
-- zero-width and bidi formatting characters, and the byte-order mark. Other international
-- letters remain valid. Must match `contactExcluded` in backend/src/domain.ts.
CREATE OR REPLACE FUNCTION is_demo_contact(value text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT length(value) <= 254 AND value ~ ('^(\+?[0-9]{7,15}|' ||
    '[^@A-Z\u0001-\u0020\u007f-\u00a0\u1680\u180e\u2000-\u200f\u2028-\u202f\u205f-\u206f\u3000\ufeff]+@' ||
    '[^@A-Z\u0001-\u0020\u007f-\u00a0\u1680\u180e\u2000-\u200f\u2028-\u202f\u205f-\u206f\u3000\ufeff]+\.' ||
    '[^@A-Z\u0001-\u0020\u007f-\u00a0\u1680\u180e\u2000-\u200f\u2028-\u202f\u205f-\u206f\u3000\ufeff]+)$')
$$;
