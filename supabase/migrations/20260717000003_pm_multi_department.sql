-- Preventive Maintenance: allow an asset to have MORE THAN ONE responsible
-- department (e.g. Front Office + Engineering). We keep the existing single
-- `department` column as the PRIMARY department (used for the single-department
-- escalation Case and for report grouping) and add a `departments text[]` array
-- holding the full set. Notification routing, approval authority and staff
-- scoping all use the full array.

ALTER TABLE kaizen_pm_assets ADD COLUMN IF NOT EXISTS departments text[];

-- Backfill: seed the array from the existing single department.
UPDATE kaizen_pm_assets
  SET departments = ARRAY[department]
  WHERE department IS NOT NULL AND department <> '' AND departments IS NULL;

-- Effective responsible departments for an asset: the array when set, else the
-- single column, else empty.
CREATE OR REPLACE FUNCTION kaizen_pm_asset_departments(p_asset uuid)
RETURNS text[] LANGUAGE sql STABLE AS $$
  SELECT COALESCE(
    NULLIF(a.departments, '{}'::text[]),
    CASE WHEN a.department IS NULL OR a.department = '' THEN '{}'::text[] ELSE ARRAY[a.department] END
  )
  FROM kaizen_pm_assets a WHERE a.id = p_asset
$$;

-- Complete a task: notify managers of ANY responsible department (approval path).
CREATE OR REPLACE FUNCTION kaizen_pm_complete_task(
  p_task uuid, p_checklist jsonb DEFAULT '[]'::jsonb,
  p_findings text DEFAULT NULL, p_readings text DEFAULT NULL, p_parts text DEFAULT NULL
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
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
        AND (p.role = 'super_admin' OR (p.role = 'manager' AND p.department = ANY(v_depts)));
  ELSE
    UPDATE kaizen_pm_assets SET last_maintenance_date = CURRENT_DATE,
      next_maintenance_date = kaizen_pm_advance(v_due, v_unit, v_interval), updated_at = now() WHERE id = v_asset;
    IF v_case IS NOT NULL THEN
      UPDATE kaizen_cases SET status = 'closed', closed_at = now(), updated_at = now()
        WHERE id = v_case AND status <> 'closed';
    END IF;
  END IF;
END $$;

-- Approve: a manager of ANY responsible department (or Top Management) may approve.
CREATE OR REPLACE FUNCTION kaizen_pm_approve_task(p_task uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_asset uuid; v_company uuid; v_unit text; v_interval int; v_depts text[]; v_name text; v_perf uuid; v_case uuid; v_due date;
BEGIN
  SELECT t.asset_id, t.company_id, t.performed_by, t.escalated_case_id, t.due_date INTO v_asset, v_company, v_perf, v_case, v_due FROM kaizen_pm_tasks t WHERE t.id = p_task;
  IF v_asset IS NULL THEN RAISE EXCEPTION 'Task not found'; END IF;
  IF v_company NOT IN (SELECT kaizen_user_company_ids()) THEN RAISE EXCEPTION 'Not authorised'; END IF;
  SELECT freq_unit, freq_interval, name INTO v_unit, v_interval, v_name FROM kaizen_pm_assets WHERE id = v_asset;
  v_depts := kaizen_pm_asset_departments(v_asset);
  IF NOT EXISTS (SELECT 1 FROM kaizen_profiles p WHERE p.id = auth.uid()
                 AND (p.role = 'super_admin' OR (p.role = 'manager' AND p.department = ANY(v_depts)))) THEN
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
END $$;

-- Reject: same authority as approve.
CREATE OR REPLACE FUNCTION kaizen_pm_reject_task(p_task uuid, p_note text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_asset uuid; v_company uuid; v_depts text[]; v_name text; v_perf uuid;
BEGIN
  SELECT t.asset_id, t.company_id, t.performed_by INTO v_asset, v_company, v_perf FROM kaizen_pm_tasks t WHERE t.id = p_task;
  IF v_asset IS NULL THEN RAISE EXCEPTION 'Task not found'; END IF;
  IF v_company NOT IN (SELECT kaizen_user_company_ids()) THEN RAISE EXCEPTION 'Not authorised'; END IF;
  SELECT name INTO v_name FROM kaizen_pm_assets WHERE id = v_asset;
  v_depts := kaizen_pm_asset_departments(v_asset);
  IF NOT EXISTS (SELECT 1 FROM kaizen_profiles p WHERE p.id = auth.uid()
                 AND (p.role = 'super_admin' OR (p.role = 'manager' AND p.department = ANY(v_depts)))) THEN
    RAISE EXCEPTION 'Only a responsible department manager or Top Management can reject';
  END IF;
  UPDATE kaizen_pm_tasks SET status = 'in_progress', notes = p_note, updated_at = now() WHERE id = p_task;
  IF v_perf IS NOT NULL THEN
    INSERT INTO kaizen_notifications (user_id, title, message, notification_type)
      VALUES (v_perf, 'Maintenance returned', COALESCE(v_name,'Asset') || ' maintenance was returned' ||
        CASE WHEN p_note IS NOT NULL THEN ': ' || p_note ELSE '.' END, 'pm');
  END IF;
END $$;

-- Sync: materialize tasks, escalate overdue → Case, route reminders to ALL
-- responsible departments' managers (Top Management + Engineering rules unchanged).
CREATE OR REPLACE FUNCTION public.kaizen_pm_sync()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE rec record; v_case uuid; v_dept text; v_overdue boolean; v_notify_eng boolean;
BEGIN
  -- 1) Materialise scheduled tasks for active assets that don't already have an open one.
  INSERT INTO kaizen_pm_tasks (company_id, asset_id, due_date, status)
  SELECT a.company_id, a.id, a.next_maintenance_date, 'scheduled'
  FROM kaizen_pm_assets a
  WHERE a.is_active AND a.next_maintenance_date IS NOT NULL
    AND a.company_id IN (SELECT kaizen_user_company_ids())
    AND NOT EXISTS (SELECT 1 FROM kaizen_pm_tasks t WHERE t.asset_id = a.id
                    AND t.status IN ('scheduled','in_progress','pending_approval'));

  -- 2) Escalate tasks overdue by >= escalate_days into a high-priority Case.
  FOR rec IN
    SELECT t.id, a.id AS asset_id, a.company_id, a.name, a.location, a.serial_no, a.model,
           kaizen_pm_asset_departments(a.id) AS depts,
           COALESCE(s.notify_engineering, false) AS notify_eng,
           COALESCE(s.engineering_excluded_assets, '{}'::uuid[]) AS excluded
    FROM kaizen_pm_tasks t JOIN kaizen_pm_assets a ON a.id = t.asset_id
    LEFT JOIN kaizen_pm_settings s ON s.company_id = a.company_id
    WHERE t.status IN ('scheduled','in_progress') AND t.escalated_case_id IS NULL
      AND COALESCE(s.escalate_enabled, true)
      AND t.due_date <= CURRENT_DATE - COALESCE(s.escalate_days, 3)
      AND a.company_id IN (SELECT kaizen_user_company_ids())
  LOOP
    v_dept := COALESCE(rec.depts[1], 'engineering_team');  -- Case carries a single (primary) department
    v_notify_eng := rec.notify_eng AND NOT (rec.asset_id = ANY(rec.excluded));
    INSERT INTO kaizen_cases (case_number, title, description, department, priority, category, location, company_id, status)
      VALUES ('PM-' || to_char(now(), 'YYYYMMDD') || '-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 6),
        'Overdue maintenance: ' || rec.name,
        'Auto-created from an overdue preventive-maintenance task.'
          || CASE WHEN COALESCE(rec.serial_no, '') <> '' THEN E'\nSerial: ' || rec.serial_no ELSE '' END
          || CASE WHEN COALESCE(rec.model, '') <> '' THEN E'\nModel: ' || rec.model ELSE '' END,
        v_dept, 'high', 'preventive_maintenance', rec.location, rec.company_id, 'open')
      RETURNING id INTO v_case;
    UPDATE kaizen_pm_tasks SET escalated_case_id = v_case, reminded_at = CURRENT_DATE WHERE id = rec.id;
    INSERT INTO kaizen_notifications (user_id, case_id, title, message, notification_type)
      SELECT p.id, v_case, 'Maintenance escalated to a case', rec.name || ' is overdue and was escalated to a case.', 'pm'
      FROM kaizen_profiles p WHERE p.company_id = rec.company_id AND p.is_active AND p.deleted_at IS NULL
        AND ( p.role = 'super_admin'
           OR (p.role = 'manager' AND p.department = ANY(rec.depts))
           OR (v_notify_eng AND p.department = 'engineering_team') );
  END LOOP;

  -- 3) Due-soon / overdue reminders.
  FOR rec IN
    SELECT t.id, a.id AS asset_id, a.company_id, a.name, t.due_date,
           kaizen_pm_asset_departments(a.id) AS depts,
           COALESCE(s.notify_engineering, false) AS notify_eng,
           COALESCE(s.engineering_excluded_assets, '{}'::uuid[]) AS excluded
    FROM kaizen_pm_tasks t JOIN kaizen_pm_assets a ON a.id = t.asset_id
    LEFT JOIN kaizen_pm_settings s ON s.company_id = a.company_id
    WHERE t.status IN ('scheduled','in_progress') AND t.escalated_case_id IS NULL
      AND (t.reminded_at IS NULL OR t.reminded_at < CURRENT_DATE)
      AND t.due_date <= CURRENT_DATE + COALESCE(s.due_soon_days, 7)
      AND a.company_id IN (SELECT kaizen_user_company_ids())
  LOOP
    v_overdue := rec.due_date < CURRENT_DATE;
    v_notify_eng := rec.notify_eng AND NOT (rec.asset_id = ANY(rec.excluded));
    INSERT INTO kaizen_notifications (user_id, title, message, notification_type)
      SELECT p.id,
        CASE WHEN v_overdue THEN 'Maintenance overdue' ELSE 'Maintenance due soon' END,
        rec.name || CASE WHEN v_overdue THEN ' is overdue.' ELSE ' is due on ' || to_char(rec.due_date, 'DD Mon') || '.' END,
        'pm'
      FROM kaizen_profiles p WHERE p.company_id = rec.company_id AND p.is_active AND p.deleted_at IS NULL
        AND ( (v_overdue AND p.role = 'super_admin')
           OR (p.role = 'manager' AND p.department = ANY(rec.depts))
           OR (v_notify_eng AND p.department = 'engineering_team') );
    UPDATE kaizen_pm_tasks SET reminded_at = CURRENT_DATE WHERE id = rec.id;
  END LOOP;
END $function$;

NOTIFY pgrst, 'reload schema';
