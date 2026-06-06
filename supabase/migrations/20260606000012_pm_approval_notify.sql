-- Preventive Maintenance Phase 5: approval workflow, notifications,
-- overdue→Case escalation, configurable thresholds.

-- Per-company PM settings (defaults applied via COALESCE when no row exists).
CREATE TABLE IF NOT EXISTS kaizen_pm_settings (
  company_id        uuid PRIMARY KEY REFERENCES kaizen_companies(id) ON DELETE CASCADE,
  require_approval  boolean NOT NULL DEFAULT true,
  due_soon_days     int     NOT NULL DEFAULT 7,
  escalate_enabled  boolean NOT NULL DEFAULT true,
  escalate_days     int     NOT NULL DEFAULT 3,
  updated_at        timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE kaizen_pm_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY kps_select ON kaizen_pm_settings FOR SELECT TO authenticated
  USING (company_id IN (SELECT kaizen_user_company_ids()));
CREATE POLICY kps_write ON kaizen_pm_settings FOR ALL TO authenticated
  USING (company_id IN (SELECT kaizen_user_company_ids())
    AND EXISTS (SELECT 1 FROM kaizen_profiles p WHERE p.id = auth.uid() AND p.role = 'super_admin'))
  WITH CHECK (company_id IN (SELECT kaizen_user_company_ids())
    AND EXISTS (SELECT 1 FROM kaizen_profiles p WHERE p.id = auth.uid() AND p.role = 'super_admin'));

-- Dedup columns for escalation + reminders.
ALTER TABLE kaizen_pm_tasks ADD COLUMN IF NOT EXISTS escalated_case_id uuid REFERENCES kaizen_cases(id) ON DELETE SET NULL;
ALTER TABLE kaizen_pm_tasks ADD COLUMN IF NOT EXISTS reminded_at date;

-- Helper: add a frequency interval to a date.
CREATE OR REPLACE FUNCTION kaizen_pm_advance(p_unit text, p_interval int)
RETURNS date LANGUAGE sql IMMUTABLE AS $$
  SELECT (CURRENT_DATE + CASE p_unit
    WHEN 'day'   THEN make_interval(days   => p_interval)
    WHEN 'week'  THEN make_interval(weeks  => p_interval)
    WHEN 'month' THEN make_interval(months => p_interval)
    WHEN 'year'  THEN make_interval(years  => p_interval)
  END)::date
$$;

-- Complete a task: respects the company's require_approval setting.
CREATE OR REPLACE FUNCTION kaizen_pm_complete_task(
  p_task uuid, p_checklist jsonb DEFAULT '[]'::jsonb,
  p_findings text DEFAULT NULL, p_readings text DEFAULT NULL, p_parts text DEFAULT NULL
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_asset uuid; v_company uuid; v_unit text; v_interval int; v_dept text; v_name text; v_require boolean;
BEGIN
  SELECT t.asset_id, t.company_id INTO v_asset, v_company FROM kaizen_pm_tasks t WHERE t.id = p_task;
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
      next_maintenance_date = kaizen_pm_advance(v_unit, v_interval), updated_at = now() WHERE id = v_asset;
  END IF;
END $$;

-- Approve a pending task → advance the asset cycle.
CREATE OR REPLACE FUNCTION kaizen_pm_approve_task(p_task uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_asset uuid; v_company uuid; v_unit text; v_interval int; v_dept text; v_name text; v_perf uuid;
BEGIN
  SELECT t.asset_id, t.company_id, t.performed_by INTO v_asset, v_company, v_perf FROM kaizen_pm_tasks t WHERE t.id = p_task;
  IF v_asset IS NULL THEN RAISE EXCEPTION 'Task not found'; END IF;
  IF v_company NOT IN (SELECT kaizen_user_company_ids()) THEN RAISE EXCEPTION 'Not authorised'; END IF;
  SELECT freq_unit, freq_interval, department, name INTO v_unit, v_interval, v_dept, v_name FROM kaizen_pm_assets WHERE id = v_asset;
  IF NOT EXISTS (SELECT 1 FROM kaizen_profiles p WHERE p.id = auth.uid()
                 AND (p.role = 'super_admin' OR (p.role = 'manager' AND p.department = v_dept))) THEN
    RAISE EXCEPTION 'Only the responsible department manager or Top Management can approve';
  END IF;
  UPDATE kaizen_pm_tasks SET status = 'approved', approver_id = auth.uid(), approved_at = now(), updated_at = now() WHERE id = p_task;
  UPDATE kaizen_pm_assets SET last_maintenance_date = CURRENT_DATE,
    next_maintenance_date = kaizen_pm_advance(v_unit, v_interval), updated_at = now() WHERE id = v_asset;
  IF v_perf IS NOT NULL THEN
    INSERT INTO kaizen_notifications (user_id, title, message, notification_type)
      VALUES (v_perf, 'Maintenance approved', COALESCE(v_name,'Asset') || ' maintenance was approved.', 'pm');
  END IF;
END $$;

-- Reject a pending task → return to performer with a note.
CREATE OR REPLACE FUNCTION kaizen_pm_reject_task(p_task uuid, p_note text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_asset uuid; v_company uuid; v_dept text; v_name text; v_perf uuid;
BEGIN
  SELECT t.asset_id, t.company_id, t.performed_by INTO v_asset, v_company, v_perf FROM kaizen_pm_tasks t WHERE t.id = p_task;
  IF v_asset IS NULL THEN RAISE EXCEPTION 'Task not found'; END IF;
  IF v_company NOT IN (SELECT kaizen_user_company_ids()) THEN RAISE EXCEPTION 'Not authorised'; END IF;
  SELECT department, name INTO v_dept, v_name FROM kaizen_pm_assets WHERE id = v_asset;
  IF NOT EXISTS (SELECT 1 FROM kaizen_profiles p WHERE p.id = auth.uid()
                 AND (p.role = 'super_admin' OR (p.role = 'manager' AND p.department = v_dept))) THEN
    RAISE EXCEPTION 'Only the responsible department manager or Top Management can reject';
  END IF;
  UPDATE kaizen_pm_tasks SET status = 'in_progress', notes = p_note, updated_at = now() WHERE id = p_task;
  IF v_perf IS NOT NULL THEN
    INSERT INTO kaizen_notifications (user_id, title, message, notification_type)
      VALUES (v_perf, 'Maintenance returned', COALESCE(v_name,'Asset') || ' maintenance was returned' ||
        CASE WHEN p_note IS NOT NULL THEN ': ' || p_note ELSE '.' END, 'pm');
  END IF;
END $$;

-- Run on PM load: materialize upcoming tasks, escalate overdue ones to Cases,
-- and send due/overdue reminders (deduped).
CREATE OR REPLACE FUNCTION kaizen_pm_sync()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE rec record; v_case uuid; v_dept text;
BEGIN
  -- 1) Ensure one open task per active asset at its next due date.
  INSERT INTO kaizen_pm_tasks (company_id, asset_id, due_date, status)
  SELECT a.company_id, a.id, a.next_maintenance_date, 'scheduled'
  FROM kaizen_pm_assets a
  WHERE a.is_active AND a.next_maintenance_date IS NOT NULL
    AND a.company_id IN (SELECT kaizen_user_company_ids())
    AND NOT EXISTS (SELECT 1 FROM kaizen_pm_tasks t WHERE t.asset_id = a.id
                    AND t.status IN ('scheduled','in_progress','pending_approval'));

  -- 2) Escalate long-overdue open tasks to a Case (once).
  FOR rec IN
    SELECT t.id, a.company_id, a.name, a.location, a.department
    FROM kaizen_pm_tasks t JOIN kaizen_pm_assets a ON a.id = t.asset_id
    LEFT JOIN kaizen_pm_settings s ON s.company_id = a.company_id
    WHERE t.status IN ('scheduled','in_progress') AND t.escalated_case_id IS NULL
      AND COALESCE(s.escalate_enabled, true)
      AND t.due_date <= CURRENT_DATE - COALESCE(s.escalate_days, 3)
      AND a.company_id IN (SELECT kaizen_user_company_ids())
  LOOP
    v_dept := COALESCE(NULLIF(rec.department, ''), 'engineering_team');
    INSERT INTO kaizen_cases (case_number, title, description, department, priority, category, location, company_id, status)
      VALUES ('PM-' || to_char(now(), 'YYYYMMDD') || '-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 6),
        'Overdue maintenance: ' || rec.name,
        'Auto-created from an overdue preventive-maintenance task.',
        v_dept, 'high', 'maintenance', rec.location, rec.company_id, 'open')
      RETURNING id INTO v_case;
    UPDATE kaizen_pm_tasks SET escalated_case_id = v_case, reminded_at = CURRENT_DATE WHERE id = rec.id;
    INSERT INTO kaizen_notifications (user_id, case_id, title, message, notification_type)
      SELECT p.id, v_case, 'Maintenance escalated to a case', rec.name || ' is overdue and was escalated to a case.', 'pm'
      FROM kaizen_profiles p WHERE p.company_id = rec.company_id AND p.is_active AND p.deleted_at IS NULL
        AND (p.role = 'super_admin' OR (p.role = 'manager' AND p.department = v_dept));
  END LOOP;

  -- 3) Due-soon / overdue reminders (once per day per task).
  FOR rec IN
    SELECT t.id, a.company_id, a.name, a.department, t.due_date
    FROM kaizen_pm_tasks t JOIN kaizen_pm_assets a ON a.id = t.asset_id
    LEFT JOIN kaizen_pm_settings s ON s.company_id = a.company_id
    WHERE t.status IN ('scheduled','in_progress') AND t.escalated_case_id IS NULL
      AND (t.reminded_at IS NULL OR t.reminded_at < CURRENT_DATE)
      AND t.due_date <= CURRENT_DATE + COALESCE(s.due_soon_days, 7)
      AND a.company_id IN (SELECT kaizen_user_company_ids())
  LOOP
    v_dept := COALESCE(NULLIF(rec.department, ''), 'engineering_team');
    INSERT INTO kaizen_notifications (user_id, title, message, notification_type)
      SELECT p.id,
        CASE WHEN rec.due_date < CURRENT_DATE THEN 'Maintenance overdue' ELSE 'Maintenance due soon' END,
        rec.name || CASE WHEN rec.due_date < CURRENT_DATE THEN ' is overdue.' ELSE ' is due on ' || to_char(rec.due_date, 'DD Mon') || '.' END,
        'pm'
      FROM kaizen_profiles p WHERE p.company_id = rec.company_id AND p.is_active AND p.deleted_at IS NULL
        AND (p.role = 'super_admin' OR (p.role = 'manager' AND p.department = v_dept));
    UPDATE kaizen_pm_tasks SET reminded_at = CURRENT_DATE WHERE id = rec.id;
  END LOOP;
END $$;

REVOKE EXECUTE ON FUNCTION kaizen_pm_approve_task(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION kaizen_pm_reject_task(uuid, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION kaizen_pm_sync() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION kaizen_pm_approve_task(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION kaizen_pm_reject_task(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION kaizen_pm_sync() TO authenticated;

NOTIFY pgrst, 'reload schema';
