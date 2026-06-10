-- Role-based PMS notification routing in kaizen_pm_sync:
--   • Top Management (super_admin): OVERDUE + ESCALATED only (no due-soon)
--   • Responsible department manager: all task notifications for their department
--   • Engineering users: due-soon + overdue + escalated, when notify_engineering is on
--       and the asset is not in engineering_excluded_assets
-- Escalation of an overdue task into a high-priority Case is unchanged.
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
    SELECT t.id, a.id AS asset_id, a.company_id, a.name, a.location, a.department, a.serial_no, a.model,
           COALESCE(s.notify_engineering, false) AS notify_eng,
           COALESCE(s.engineering_excluded_assets, '{}'::uuid[]) AS excluded
    FROM kaizen_pm_tasks t JOIN kaizen_pm_assets a ON a.id = t.asset_id
    LEFT JOIN kaizen_pm_settings s ON s.company_id = a.company_id
    WHERE t.status IN ('scheduled','in_progress') AND t.escalated_case_id IS NULL
      AND COALESCE(s.escalate_enabled, true)
      AND t.due_date <= CURRENT_DATE - COALESCE(s.escalate_days, 3)
      AND a.company_id IN (SELECT kaizen_user_company_ids())
  LOOP
    v_dept := COALESCE(NULLIF(rec.department, ''), 'engineering_team');
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
    -- Escalation recipients: Top Management + responsible dept manager + (Engineering users if enabled & not excluded)
    INSERT INTO kaizen_notifications (user_id, case_id, title, message, notification_type)
      SELECT p.id, v_case, 'Maintenance escalated to a case', rec.name || ' is overdue and was escalated to a case.', 'pm'
      FROM kaizen_profiles p WHERE p.company_id = rec.company_id AND p.is_active AND p.deleted_at IS NULL
        AND ( p.role = 'super_admin'
           OR (p.role = 'manager' AND p.department = v_dept)
           OR (v_notify_eng AND p.department = 'engineering_team') );
  END LOOP;

  -- 3) Due-soon / overdue reminders.
  FOR rec IN
    SELECT t.id, a.id AS asset_id, a.company_id, a.name, a.department, t.due_date,
           COALESCE(s.notify_engineering, false) AS notify_eng,
           COALESCE(s.engineering_excluded_assets, '{}'::uuid[]) AS excluded
    FROM kaizen_pm_tasks t JOIN kaizen_pm_assets a ON a.id = t.asset_id
    LEFT JOIN kaizen_pm_settings s ON s.company_id = a.company_id
    WHERE t.status IN ('scheduled','in_progress') AND t.escalated_case_id IS NULL
      AND (t.reminded_at IS NULL OR t.reminded_at < CURRENT_DATE)
      AND t.due_date <= CURRENT_DATE + COALESCE(s.due_soon_days, 7)
      AND a.company_id IN (SELECT kaizen_user_company_ids())
  LOOP
    v_dept := COALESCE(NULLIF(rec.department, ''), 'engineering_team');
    v_overdue := rec.due_date < CURRENT_DATE;
    v_notify_eng := rec.notify_eng AND NOT (rec.asset_id = ANY(rec.excluded));
    -- Recipients:
    --   • Top Management (super_admin) → OVERDUE only (not due-soon)
    --   • Responsible dept manager → always (due-soon + overdue)
    --   • Engineering users → when enabled & asset not excluded (due-soon + overdue)
    INSERT INTO kaizen_notifications (user_id, title, message, notification_type)
      SELECT p.id,
        CASE WHEN v_overdue THEN 'Maintenance overdue' ELSE 'Maintenance due soon' END,
        rec.name || CASE WHEN v_overdue THEN ' is overdue.' ELSE ' is due on ' || to_char(rec.due_date, 'DD Mon') || '.' END,
        'pm'
      FROM kaizen_profiles p WHERE p.company_id = rec.company_id AND p.is_active AND p.deleted_at IS NULL
        AND ( (v_overdue AND p.role = 'super_admin')
           OR (p.role = 'manager' AND p.department = v_dept)
           OR (v_notify_eng AND p.department = 'engineering_team') );
    UPDATE kaizen_pm_tasks SET reminded_at = CURRENT_DATE WHERE id = rec.id;
  END LOOP;
END $function$;
