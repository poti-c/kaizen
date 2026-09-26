-- PM approval for covering managers. PMSchedule shows Approve/Reject to a
-- manager when getEffectiveDepts(profile) — own department plus
-- managed_departments — overlaps the asset's departments, but these functions
-- only accepted p.department, so a covering manager's approve/reject always
-- raised "Only a responsible department manager or Top Management can ...".
-- kaizen_pm_complete_task's "awaiting approval" notification used the same
-- rule, so covering managers were also never told there was something to approve.
--
-- Each function below is the live definition verbatim, with only the manager
-- test widened to: p.department = ANY(v_depts) OR p.managed_departments && v_depts.
-- CREATE OR REPLACE keeps the existing grants (authenticated + service_role;
-- no anon — see 20260719000005_function_execute_acl_lockdown.sql). Idempotent.

CREATE OR REPLACE FUNCTION public.kaizen_pm_approve_task(p_task uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE v_asset uuid; v_company uuid; v_unit text; v_interval int; v_depts text[]; v_name text; v_perf uuid; v_case uuid; v_due date;
BEGIN
  SELECT t.asset_id, t.company_id, t.performed_by, t.escalated_case_id, t.due_date INTO v_asset, v_company, v_perf, v_case, v_due FROM kaizen_pm_tasks t WHERE t.id = p_task;
  IF v_asset IS NULL THEN RAISE EXCEPTION 'Task not found'; END IF;
  IF v_company NOT IN (SELECT kaizen_user_company_ids()) THEN RAISE EXCEPTION 'Not authorised'; END IF;
  SELECT freq_unit, freq_interval, name INTO v_unit, v_interval, v_name FROM kaizen_pm_assets WHERE id = v_asset;
  v_depts := kaizen_pm_asset_departments(v_asset);
  IF NOT EXISTS (SELECT 1 FROM kaizen_profiles p WHERE p.id = auth.uid()
                 AND (p.role = 'super_admin' OR (p.role = 'manager'
                      AND (p.department = ANY(v_depts) OR COALESCE(p.managed_departments, '{}'::text[]) && v_depts)))) THEN
    RAISE EXCEPTION 'Only a responsible department manager or Top Management can approve';
  END IF;
  UPDATE kaizen_pm_tasks SET status = 'approved', approver_id = auth.uid(), approved_at = now(), updated_at = now() WHERE id = p_task;
  UPDATE kaizen_pm_assets SET last_maintenance_date = CURRENT_DATE,
    next_maintenance_date = kaizen_pm_advance(v_due, v_unit, v_interval), updated_at = now() WHERE id = v_asset;
  IF v_case IS NOT NULL THEN
    UPDATE kaizen_cases SET status = 'closed', closed_at = now(), updated_at = now()
      WHERE id = v_case AND status <> 'closed';
  END IF;
  IF v_perf IS NOT NULL THEN
    INSERT INTO kaizen_notifications (user_id, title, message, notification_type)
      VALUES (v_perf, 'Maintenance approved', COALESCE(v_name,'Asset') || ' maintenance was approved.', 'pm');
  END IF;
END $function$;

CREATE OR REPLACE FUNCTION public.kaizen_pm_reject_task(p_task uuid, p_note text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE v_asset uuid; v_company uuid; v_depts text[]; v_name text; v_perf uuid;
BEGIN
  SELECT t.asset_id, t.company_id, t.performed_by INTO v_asset, v_company, v_perf FROM kaizen_pm_tasks t WHERE t.id = p_task;
  IF v_asset IS NULL THEN RAISE EXCEPTION 'Task not found'; END IF;
  IF v_company NOT IN (SELECT kaizen_user_company_ids()) THEN RAISE EXCEPTION 'Not authorised'; END IF;
  SELECT name INTO v_name FROM kaizen_pm_assets WHERE id = v_asset;
  v_depts := kaizen_pm_asset_departments(v_asset);
  IF NOT EXISTS (SELECT 1 FROM kaizen_profiles p WHERE p.id = auth.uid()
                 AND (p.role = 'super_admin' OR (p.role = 'manager'
                      AND (p.department = ANY(v_depts) OR COALESCE(p.managed_departments, '{}'::text[]) && v_depts)))) THEN
    RAISE EXCEPTION 'Only a responsible department manager or Top Management can reject';
  END IF;
  UPDATE kaizen_pm_tasks SET status = 'in_progress', notes = p_note, updated_at = now() WHERE id = p_task;
  IF v_perf IS NOT NULL THEN
    INSERT INTO kaizen_notifications (user_id, title, message, notification_type)
      VALUES (v_perf, 'Maintenance returned', COALESCE(v_name,'Asset') || ' maintenance was returned' ||
        CASE WHEN p_note IS NOT NULL THEN ': ' || p_note ELSE '.' END, 'pm');
  END IF;
END $function$;

CREATE OR REPLACE FUNCTION public.kaizen_pm_complete_task(p_task uuid, p_checklist jsonb DEFAULT '[]'::jsonb, p_findings text DEFAULT NULL::text, p_readings text DEFAULT NULL::text, p_parts text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE v_asset uuid; v_company uuid; v_unit text; v_interval int; v_depts text[]; v_name text; v_require boolean; v_case uuid; v_due date;
BEGIN
  SELECT t.asset_id, t.company_id, t.escalated_case_id, t.due_date INTO v_asset, v_company, v_case, v_due FROM kaizen_pm_tasks t WHERE t.id = p_task;
  IF v_asset IS NULL THEN RAISE EXCEPTION 'Task not found'; END IF;
  IF v_company NOT IN (SELECT kaizen_user_company_ids()) THEN RAISE EXCEPTION 'Not authorised'; END IF;
  SELECT freq_unit, freq_interval, name INTO v_unit, v_interval, v_name FROM kaizen_pm_assets WHERE id = v_asset;
  v_depts := kaizen_pm_asset_departments(v_asset);
  SELECT COALESCE((SELECT require_approval FROM kaizen_pm_settings WHERE company_id = v_company), true) INTO v_require;

  UPDATE kaizen_pm_tasks SET
    status = CASE WHEN v_require THEN 'pending_approval' ELSE 'done' END,
    performed_by = auth.uid(), performed_at = now(),
    checklist_results = COALESCE(p_checklist, '[]'::jsonb),
    findings = p_findings, readings = p_readings, parts_used = p_parts, updated_at = now()
  WHERE id = p_task;

  IF v_require THEN
    INSERT INTO kaizen_notifications (user_id, title, message, notification_type)
      SELECT p.id, 'Maintenance awaiting approval', COALESCE(v_name,'Asset') || ' maintenance is ready for your approval.', 'pm'
      FROM kaizen_profiles p WHERE p.company_id = v_company AND p.is_active AND p.deleted_at IS NULL
        AND (p.role = 'super_admin' OR (p.role = 'manager'
             AND (p.department = ANY(v_depts) OR COALESCE(p.managed_departments, '{}'::text[]) && v_depts)));
  ELSE
    UPDATE kaizen_pm_assets SET last_maintenance_date = CURRENT_DATE,
      next_maintenance_date = kaizen_pm_advance(v_due, v_unit, v_interval), updated_at = now() WHERE id = v_asset;
    IF v_case IS NOT NULL THEN
      UPDATE kaizen_cases SET status = 'closed', closed_at = now(), updated_at = now()
        WHERE id = v_case AND status <> 'closed';
    END IF;
  END IF;
END $function$;
