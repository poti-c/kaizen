-- CaseDetailPage-003: final closure of a case is Top Management's step. The UI's
-- normal flow already enforces this (a manager's approval only moves a case to
-- pending_admin_approval; handleManagerApprove/handleAdminApprove close only for
-- super_admin), but the Edit modal let a department manager pick "closed" and
-- stamp admin_approved_by with their OWN id — a Top Management approval that
-- never happened. The kzn_cases_update RLS policy lets any manager update any
-- case row, so a raw PATCH could do the same.
--
-- Same convention as kaizen_cases_prevent_pic_bypass (20260720000000): keep RLS
-- broad, enforce "who may change this column" with a BEFORE UPDATE trigger.
--
-- Enforced ONLY for direct client writes (current_user = 'authenticated'):
--   * service_role / edge functions (current_user = 'service_role') are exempt.
--   * SECURITY DEFINER functions run as their owner, so current_user is NOT
--     'authenticated' there. This keeps the PM flow working: kaizen_pm_complete_task
--     and kaizen_pm_approve_task close the escalated case on behalf of staff /
--     department managers (auth.uid() is set, but it is a vetted server path).
-- Clearing admin_approved_by (rollback to an open status, reopen) stays allowed —
-- only setting or changing it to a non-null value is a Top Management stamp.
CREATE OR REPLACE FUNCTION kaizen_cases_close_requires_super_admin()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF current_user <> 'authenticated' OR auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;

  IF (
       (NEW.status = 'closed' AND OLD.status IS DISTINCT FROM 'closed')
       OR (NEW.admin_approved_by IS NOT NULL AND NEW.admin_approved_by IS DISTINCT FROM OLD.admin_approved_by)
     )
     AND COALESCE(public.kaizen_current_role(), '') <> 'super_admin'
  THEN
    RAISE EXCEPTION 'Only Top Management (super_admin) can close a case or record admin approval';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS kaizen_cases_close_requires_super_admin ON kaizen_cases;
CREATE TRIGGER kaizen_cases_close_requires_super_admin
  BEFORE UPDATE ON kaizen_cases
  FOR EACH ROW EXECUTE FUNCTION kaizen_cases_close_requires_super_admin();

-- Trigger functions are never called directly, but Supabase's default privileges
-- grant EXECUTE to anon/authenticated on every new function (see CLAUDE.md), so
-- name the roles. Triggers fire regardless of the caller's EXECUTE privilege.
REVOKE ALL ON FUNCTION public.kaizen_cases_close_requires_super_admin() FROM PUBLIC, anon, authenticated;
