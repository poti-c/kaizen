-- PM cadence fix: advance the next maintenance date from the task's SCHEDULED
-- due_date, not from CURRENT_DATE.
--
-- Bug: kaizen_pm_advance(unit, interval) computed `CURRENT_DATE + interval`, so
-- completing/approving a task EARLY reset the whole cycle to "one interval from
-- today". A monthly asset whose task (due Aug 12) was completed on Jul 17 got its
-- next occurrence set to Aug 17 — only ~5 days after the one just closed — making a
-- "monthly" asset look like it recurs every few days on the calendar.
--
-- Fix: anchor the next occurrence on the task's due_date so a fixed cadence is
-- preserved regardless of when the work is actually done. Floor to CURRENT_DATE so
-- a task completed LATE still schedules the next one in the future (catch-up)
-- instead of in the past. last_maintenance_date still records the actual work date.

-- New signature takes the task's scheduled due date as the anchor.
CREATE OR REPLACE FUNCTION kaizen_pm_advance(p_due date, p_unit text, p_interval int)
RETURNS date LANGUAGE sql STABLE AS $$
  SELECT (GREATEST(COALESCE(p_due, CURRENT_DATE), CURRENT_DATE) + CASE p_unit
    WHEN 'day'   THEN make_interval(days   => p_interval)
    WHEN 'week'  THEN make_interval(weeks  => p_interval)
    WHEN 'month' THEN make_interval(months => p_interval)
    WHEN 'year'  THEN make_interval(years  => p_interval)
  END)::date
$$;

-- Retire the old today-anchored helper (both callers move to the 3-arg version below).
DROP FUNCTION IF EXISTS kaizen_pm_advance(text, int);

CREATE OR REPLACE FUNCTION kaizen_pm_complete_task(
  p_task uuid, p_checklist jsonb DEFAULT '[]'::jsonb,
  p_findings text DEFAULT NULL, p_readings text DEFAULT NULL, p_parts text DEFAULT NULL
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_asset uuid; v_company uuid; v_unit text; v_interval int; v_dept text; v_name text; v_require boolean; v_case uuid; v_due date;
BEGIN
  SELECT t.asset_id, t.company_id, t.escalated_case_id, t.due_date INTO v_asset, v_company, v_case, v_due FROM kaizen_pm_tasks t WHERE t.id = p_task;
  IF v_asset IS NULL THEN RAISE EXCEPTION 'Task not found'; END IF;
  IF v_company NOT IN (SELECT kaizen_user_company_ids()) THEN RAISE EXCEPTION 'Not authorised'; END IF;
  SELECT freq_unit, freq_interval, department, name INTO v_unit, v_interval, v_dept, v_name FROM kaizen_pm_assets WHERE id = v_asset;
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
        AND (p.role = 'super_admin' OR (p.role = 'manager' AND p.department = v_dept));
  ELSE
    UPDATE kaizen_pm_assets SET last_maintenance_date = CURRENT_DATE,
      next_maintenance_date = kaizen_pm_advance(v_due, v_unit, v_interval), updated_at = now() WHERE id = v_asset;
    -- Task is fully done (no approval needed) → close its escalated case.
    IF v_case IS NOT NULL THEN
      UPDATE kaizen_cases SET status = 'closed', closed_at = now(), updated_at = now()
        WHERE id = v_case AND status <> 'closed';
    END IF;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION kaizen_pm_approve_task(p_task uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_asset uuid; v_company uuid; v_unit text; v_interval int; v_dept text; v_name text; v_perf uuid; v_case uuid; v_due date;
BEGIN
  SELECT t.asset_id, t.company_id, t.performed_by, t.escalated_case_id, t.due_date INTO v_asset, v_company, v_perf, v_case, v_due FROM kaizen_pm_tasks t WHERE t.id = p_task;
  IF v_asset IS NULL THEN RAISE EXCEPTION 'Task not found'; END IF;
  IF v_company NOT IN (SELECT kaizen_user_company_ids()) THEN RAISE EXCEPTION 'Not authorised'; END IF;
  SELECT freq_unit, freq_interval, department, name INTO v_unit, v_interval, v_dept, v_name FROM kaizen_pm_assets WHERE id = v_asset;
  IF NOT EXISTS (SELECT 1 FROM kaizen_profiles p WHERE p.id = auth.uid()
                 AND (p.role = 'super_admin' OR (p.role = 'manager' AND p.department = v_dept))) THEN
    RAISE EXCEPTION 'Only the responsible department manager or Top Management can approve';
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
END $$;

REVOKE EXECUTE ON FUNCTION kaizen_pm_advance(date, text, int) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION kaizen_pm_advance(date, text, int) TO authenticated;

NOTIFY pgrst, 'reload schema';
