-- Backfill the 5 functions and 1 trigger that exist only in the live project,
-- AND close a privilege-escalation hole found while doing it.
--
-- ── The security fix ────────────────────────────────────────────────────────
-- The four kaizen_console_* functions are SECURITY DEFINER and owned by
-- postgres. Postgres grants EXECUTE to PUBLIC on every new function by default
-- and Supabase's anon/authenticated roles inherit that, so on live they were
-- callable by ANY anonymous client holding the publishable key — which ships
-- inside the browser bundle. Confirmed against production:
--
--   POST /rest/v1/rpc/kaizen_console_password_matches  -> HTTP 200  false
--   POST /rest/v1/rpc/kaizen_console_verify_login      -> HTTP 200  null
--
-- RLS on kaizen_console_admins does not help here: SECURITY DEFINER bypasses
-- it. The practical impact was that an anonymous caller could invoke
-- kaizen_console_create_admin and mint themselves a working Console admin
-- account, and kaizen_console_verify_login gave an unthrottled password oracle
-- (the lockout in kaizen_console_login_attempts lives in the edge function, so
-- calling the RPC directly skips it).
--
-- The REVOKE at the bottom is therefore NOT a no-op against live — it is the
-- fix. It is safe: all four are called only from
-- supabase/functions/kaizen-console/index.ts via a SUPABASE_SERVICE_ROLE_KEY
-- client, and service_role keeps EXECUTE. Nothing in src/ calls them.
--
-- Function bodies below are copied verbatim from live (pg_get_functiondef).

-- crypt()/gen_salt() live in the extensions schema; the functions below are
-- useless without them and no migration created the extension.
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

-- ── Console authentication ───────────────────────────────────────────────────
-- The Console has its own username/password login, separate from Supabase Auth.

CREATE OR REPLACE FUNCTION public.kaizen_console_verify_login(p_username text, p_password text)
  RETURNS uuid
  LANGUAGE sql
  SECURITY DEFINER
  SET search_path TO 'public', 'extensions'
AS $function$
  select id from kaizen_console_admins
  where username = lower(trim(p_username)) and is_active
    and password_hash = crypt(p_password, password_hash)
  limit 1;
$function$;

-- Used to re-confirm the current admin's password before sensitive actions.
CREATE OR REPLACE FUNCTION public.kaizen_console_password_matches(p_password text)
  RETURNS boolean
  LANGUAGE sql
  SECURITY DEFINER
  SET search_path TO 'public', 'extensions'
AS $function$
  select exists(
    select 1 from public.kaizen_console_admins
    where is_active and password_hash = crypt(p_password, password_hash)
  );
$function$;

CREATE OR REPLACE FUNCTION public.kaizen_console_create_admin(p_username text, p_password text, p_email text)
  RETURNS uuid
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public', 'extensions'
AS $function$
declare new_id uuid;
begin
  insert into kaizen_console_admins (username, password_hash, email)
  values (lower(trim(p_username)), crypt(p_password, gen_salt('bf')), nullif(trim(p_email),''))
  returning id into new_id;
  return new_id;
end; $function$;

-- Null/empty password means "leave the password alone".
CREATE OR REPLACE FUNCTION public.kaizen_console_update_admin(p_id uuid, p_username text, p_password text, p_email text)
  RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public', 'extensions'
AS $function$
begin
  update kaizen_console_admins set
    username = coalesce(nullif(lower(trim(p_username)),''), username),
    email = case when p_email is null then email else nullif(trim(p_email),'') end,
    password_hash = case when p_password is null or p_password = '' then password_hash else crypt(p_password, gen_salt('bf')) end
  where id = p_id;
end; $function$;

-- ── Default person-in-charge on new cases ────────────────────────────────────
-- Falls back to the creator so a case is never left unassigned.
-- (The columns it writes are created by 20260630000000_cases_pic_columns.sql.)
CREATE OR REPLACE FUNCTION public.kaizen_default_pic()
  RETURNS trigger
  LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.person_in_charge IS NULL THEN
    NEW.person_in_charge := NEW.created_by;
  END IF;
  IF NEW.pic_ids IS NULL OR NEW.pic_ids = '{}' THEN
    NEW.pic_ids := ARRAY[NEW.created_by];
  END IF;
  RETURN NEW;
END;
$function$;

-- CREATE TRIGGER has no IF NOT EXISTS; guard rather than DROP + CREATE, so
-- this leaves the live trigger untouched instead of briefly removing it.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
     WHERE NOT t.tgisinternal
       AND c.relname = 'kaizen_cases'
       AND t.tgname  = 'kaizen_cases_default_pic'
  ) THEN
    EXECUTE 'CREATE TRIGGER kaizen_cases_default_pic
               BEFORE INSERT ON kaizen_cases
               FOR EACH ROW EXECUTE FUNCTION kaizen_default_pic()';
  END IF;
END $$;

-- ── Lock down the console functions ──────────────────────────────────────────
-- See the header: this is the actual security fix, not a no-op.
REVOKE ALL ON FUNCTION public.kaizen_console_verify_login(text, text)          FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.kaizen_console_password_matches(text)            FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.kaizen_console_create_admin(text, text, text)    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.kaizen_console_update_admin(uuid, text, text, text) FROM PUBLIC, anon, authenticated;

-- The Console edge function reaches them with the service_role key.
GRANT EXECUTE ON FUNCTION public.kaizen_console_verify_login(text, text)          TO service_role;
GRANT EXECUTE ON FUNCTION public.kaizen_console_password_matches(text)            TO service_role;
GRANT EXECUTE ON FUNCTION public.kaizen_console_create_admin(text, text, text)    TO service_role;
GRANT EXECUTE ON FUNCTION public.kaizen_console_update_admin(uuid, text, text, text) TO service_role;

NOTIFY pgrst, 'reload schema';
