-- Make preventive-maintenance cases searchable by the asset's serial number and
-- model: embed them into the auto-created case description. The Cases keyword
-- search matches the description, so typing a serial number now finds the case.

CREATE OR REPLACE FUNCTION kaizen_pm_sync()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE rec record; v_case uuid; v_dept text;
BEGIN
  INSERT INTO kaizen_pm_tasks (company_id, asset_id, due_date, status)
  SELECT a.company_id, a.id, a.next_maintenance_date, 'scheduled'
  FROM kaizen_pm_assets a
  WHERE a.is_active AND a.next_maintenance_date IS NOT NULL
    AND a.company_id IN (SELECT kaizen_user_company_ids())
    AND NOT EXISTS (SELECT 1 FROM kaizen_pm_tasks t WHERE t.asset_id = a.id
                    AND t.status IN ('scheduled','in_progress','pending_approval'));

  FOR rec IN
    SELECT t.id, a.company_id, a.name, a.location, a.department, a.serial_no, a.model
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
        'Auto-created from an overdue preventive-maintenance task.'
          || CASE WHEN COALESCE(rec.serial_no, '') <> '' THEN E'\nSerial: ' || rec.serial_no ELSE '' END
          || CASE WHEN COALESCE(rec.model, '') <> '' THEN E'\nModel: ' || rec.model ELSE '' END,
        v_dept, 'high', 'preventive_maintenance', rec.location, rec.company_id, 'open')
      RETURNING id INTO v_case;
    UPDATE kaizen_pm_tasks SET escalated_case_id = v_case, reminded_at = CURRENT_DATE WHERE id = rec.id;
    INSERT INTO kaizen_notifications (user_id, case_id, title, message, notification_type)
      SELECT p.id, v_case, 'Maintenance escalated to a case', rec.name || ' is overdue and was escalated to a case.', 'pm'
      FROM kaizen_profiles p WHERE p.company_id = rec.company_id AND p.is_active AND p.deleted_at IS NULL
        AND (p.role = 'super_admin' OR (p.role = 'manager' AND p.department = v_dept));
  END LOOP;

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

-- Backfill existing PM cases so their serial/model are searchable too.
UPDATE kaizen_cases c
SET description = c.description
      || CASE WHEN COALESCE(a.serial_no, '') <> '' THEN E'\nSerial: ' || a.serial_no ELSE '' END
      || CASE WHEN COALESCE(a.model, '') <> '' THEN E'\nModel: ' || a.model ELSE '' END
FROM kaizen_pm_tasks t
JOIN kaizen_pm_assets a ON a.id = t.asset_id
WHERE t.escalated_case_id = c.id
  AND c.category = 'preventive_maintenance'
  AND c.description NOT LIKE '%Serial:%'
  AND c.description NOT LIKE '%Model:%'
  AND (COALESCE(a.serial_no, '') <> '' OR COALESCE(a.model, '') <> '');

NOTIFY pgrst, 'reload schema';
