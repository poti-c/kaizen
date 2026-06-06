-- Preventive Maintenance: generated maintenance task occurrences.
CREATE TABLE IF NOT EXISTS kaizen_pm_tasks (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       uuid NOT NULL REFERENCES kaizen_companies(id) ON DELETE CASCADE,
  asset_id         uuid NOT NULL REFERENCES kaizen_pm_assets(id) ON DELETE CASCADE,
  due_date         date NOT NULL,
  status           text NOT NULL DEFAULT 'scheduled'
                     CHECK (status IN ('scheduled','in_progress','done','pending_approval','approved','cancelled')),
  assigned_to      uuid REFERENCES kaizen_profiles(id) ON DELETE SET NULL,
  performed_by     uuid REFERENCES kaizen_profiles(id) ON DELETE SET NULL,
  performed_at     timestamptz,
  checklist_results jsonb NOT NULL DEFAULT '[]'::jsonb,
  readings         text,
  parts_used       text,
  photos           jsonb NOT NULL DEFAULT '[]'::jsonb,
  findings         text,
  approver_id      uuid REFERENCES kaizen_profiles(id) ON DELETE SET NULL,
  approved_at      timestamptz,
  notes            text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS kaizen_pm_tasks_company_idx ON kaizen_pm_tasks (company_id);
CREATE INDEX IF NOT EXISTS kaizen_pm_tasks_asset_idx ON kaizen_pm_tasks (asset_id);
CREATE INDEX IF NOT EXISTS kaizen_pm_tasks_due_idx ON kaizen_pm_tasks (due_date);

ALTER TABLE kaizen_pm_tasks ENABLE ROW LEVEL SECURITY;

CREATE POLICY kpt_select ON kaizen_pm_tasks FOR SELECT TO authenticated
  USING (company_id IN (SELECT kaizen_user_company_ids()));
-- Company members may update a task (start / record execution).
CREATE POLICY kpt_update ON kaizen_pm_tasks FOR UPDATE TO authenticated
  USING (company_id IN (SELECT kaizen_user_company_ids()));
-- Managers/Top Management may add or remove tasks manually.
CREATE POLICY kpt_insert ON kaizen_pm_tasks FOR INSERT TO authenticated
  WITH CHECK (company_id IN (SELECT kaizen_user_company_ids())
    AND EXISTS (SELECT 1 FROM kaizen_profiles p WHERE p.id = auth.uid() AND p.role IN ('super_admin','manager')));
CREATE POLICY kpt_delete ON kaizen_pm_tasks FOR DELETE TO authenticated
  USING (company_id IN (SELECT kaizen_user_company_ids())
    AND EXISTS (SELECT 1 FROM kaizen_profiles p WHERE p.id = auth.uid() AND p.role IN ('super_admin','manager')));

-- Ensure one open task exists per active asset at its next due date.
CREATE OR REPLACE FUNCTION kaizen_pm_materialize_tasks()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  INSERT INTO kaizen_pm_tasks (company_id, asset_id, due_date, status)
  SELECT a.company_id, a.id, a.next_maintenance_date, 'scheduled'
  FROM kaizen_pm_assets a
  WHERE a.is_active
    AND a.next_maintenance_date IS NOT NULL
    AND a.company_id IN (SELECT kaizen_user_company_ids())
    AND NOT EXISTS (
      SELECT 1 FROM kaizen_pm_tasks t
      WHERE t.asset_id = a.id AND t.status IN ('scheduled','in_progress','pending_approval')
    );
END $$;

-- Complete a task and advance its asset's maintenance cycle. Runs as definer so
-- staff can complete without direct write access to the asset row.
CREATE OR REPLACE FUNCTION kaizen_pm_complete_task(
  p_task uuid, p_checklist jsonb DEFAULT '[]'::jsonb,
  p_findings text DEFAULT NULL, p_readings text DEFAULT NULL, p_parts text DEFAULT NULL
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_asset uuid; v_company uuid; v_unit text; v_interval int; v_next date;
BEGIN
  SELECT t.asset_id, t.company_id INTO v_asset, v_company FROM kaizen_pm_tasks t WHERE t.id = p_task;
  IF v_asset IS NULL THEN RAISE EXCEPTION 'Task not found'; END IF;
  IF v_company NOT IN (SELECT kaizen_user_company_ids()) THEN RAISE EXCEPTION 'Not authorised'; END IF;

  UPDATE kaizen_pm_tasks SET
    status = 'done', performed_by = auth.uid(), performed_at = now(),
    checklist_results = COALESCE(p_checklist, '[]'::jsonb),
    findings = p_findings, readings = p_readings, parts_used = p_parts, updated_at = now()
  WHERE id = p_task;

  SELECT freq_unit, freq_interval INTO v_unit, v_interval FROM kaizen_pm_assets WHERE id = v_asset;
  v_next := (CURRENT_DATE + CASE v_unit
      WHEN 'day'   THEN make_interval(days   => v_interval)
      WHEN 'week'  THEN make_interval(weeks  => v_interval)
      WHEN 'month' THEN make_interval(months => v_interval)
      WHEN 'year'  THEN make_interval(years  => v_interval)
    END)::date;
  UPDATE kaizen_pm_assets SET last_maintenance_date = CURRENT_DATE, next_maintenance_date = v_next, updated_at = now()
  WHERE id = v_asset;
END $$;

REVOKE EXECUTE ON FUNCTION kaizen_pm_materialize_tasks() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION kaizen_pm_complete_task(uuid, jsonb, text, text, text) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION kaizen_pm_materialize_tasks() TO authenticated;
GRANT  EXECUTE ON FUNCTION kaizen_pm_complete_task(uuid, jsonb, text, text, text) TO authenticated;

NOTIFY pgrst, 'reload schema';
