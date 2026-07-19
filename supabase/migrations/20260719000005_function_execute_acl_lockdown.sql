-- Lock down EXECUTE on the SECURITY DEFINER functions.
--
-- ── Why the existing REVOKEs never worked ────────────────────────────────────
-- This repo already contains eight `REVOKE EXECUTE ... FROM PUBLIC` statements
-- (20260604000001, 20260604000002, 20260606000011, 20260606000012,
--  20260607000001, 20260607000003, 20260717000001). Every one is a no-op.
--
-- Supabase runs ALTER DEFAULT PRIVILEGES granting EXECUTE to anon and
-- authenticated, so each new function is created with those as EXPLICIT grants:
--
--   postgres=X/postgres | anon=X/postgres | authenticated=X/postgres | service_role=X/postgres
--
-- `REVOKE ... FROM PUBLIC` drops the implicit PUBLIC grant, which is not what
-- holds the door open. The explicit anon grant survives. The roles have to be
-- named. That is what this migration does.
--
-- ── The two that were actually exploitable ───────────────────────────────────
-- kaizen_activate_subscription and kaizen_merge_company_addon are SECURITY
-- DEFINER with NO authorization check at all — no auth.uid(), no role test.
-- Confirmed callable anonymously against production (probed with a nonexistent
-- company UUID so no row was touched):
--
--   POST /rest/v1/rpc/kaizen_merge_company_addon   -> HTTP 204
--   POST /rest/v1/rpc/kaizen_activate_subscription -> HTTP 200
--
-- An anonymous caller could set any company's plan, subscription_end, seat
-- limits and features, or enable any addon. Company IDs are guessable
-- (a0000000-0000-0000-0000-000000000001), so nothing had to be discovered
-- first. This also bypassed 20260616000001_prelaunch_tenant_isolation.sql,
-- which deliberately does REVOKE UPDATE (subscription_end, addons, plan, ...)
-- on kaizen_companies: these functions run as postgres and ignore that.
--
-- Both are called only from supabase/functions/ via a service_role client —
-- nothing in src/ calls them — so revoking authenticated as well is safe.

REVOKE ALL ON FUNCTION public.kaizen_activate_subscription(uuid, text, integer, integer, integer, integer, boolean, jsonb)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.kaizen_merge_company_addon(uuid, text)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.kaizen_activate_subscription(uuid, text, integer, integer, integer, integer, boolean, jsonb)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.kaizen_merge_company_addon(uuid, text)
  TO service_role;

-- ── Defence in depth for the guarded functions ───────────────────────────────
-- These all check auth.uid() internally and already raise 'Not authorised' for
-- an anonymous caller, so this is not a live hole — it removes the anon grant
-- so those internal guards stop being the only thing in the way.
--
-- `authenticated` is deliberately KEPT: the app calls all of these as a signed-in
-- user (src/components/pm/PMSchedule.tsx, src/pages/CasesCalendarPage.tsx, and
-- the PM task views).
REVOKE ALL ON FUNCTION public.kaizen_pm_approve_task(uuid)                FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.kaizen_pm_reject_task(uuid, text)           FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.kaizen_pm_complete_task(uuid, jsonb, text, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.kaizen_pm_materialize_tasks()               FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.kaizen_pm_sync()                            FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.kaizen_request_receipt(uuid)                FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.kaizen_start_pms_trial(uuid)                FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.kaizen_pm_approve_task(uuid)             TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.kaizen_pm_reject_task(uuid, text)        TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.kaizen_pm_complete_task(uuid, jsonb, text, text, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.kaizen_pm_materialize_tasks()            TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.kaizen_pm_sync()                         TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.kaizen_request_receipt(uuid)             TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.kaizen_start_pms_trial(uuid)             TO authenticated, service_role;

-- Deliberately NOT touched:
--   kaizen_current_role / kaizen_current_dept / kaizen_user_company_ids /
--   kaizen_member_company_ids / kaizen_case_company — called from inside RLS
--     policies, so authenticated must retain EXECUTE. They return null/empty
--     for an anonymous caller and leak nothing.
--   kaizen_default_pic / kaizen_seed_company_taxonomy /
--   kaizen_trigger_push_notification / kaizen_default_subscription_end /
--   kaizen_profiles_prevent_self_escalation — trigger functions; calling one
--     directly errors out, so the grant is not a surface.

NOTIFY pgrst, 'reload schema';
