-- Preventive Maintenance: per-company equipment type taxonomy.
CREATE TABLE IF NOT EXISTS kaizen_pm_equipment_types (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES kaizen_companies(id) ON DELETE CASCADE,
  name        text NOT NULL,
  category    text,
  sort_order  int  NOT NULL DEFAULT 0,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS kaizen_pm_equipment_types_company_idx ON kaizen_pm_equipment_types (company_id);

ALTER TABLE kaizen_pm_equipment_types ENABLE ROW LEVEL SECURITY;

-- Read: any member of the company (managers/staff need it for asset dropdowns).
CREATE POLICY kpet_select ON kaizen_pm_equipment_types FOR SELECT TO authenticated
  USING (company_id IN (SELECT kaizen_user_company_ids()));

-- Manage: Top Management (super_admin) of the company only.
CREATE POLICY kpet_insert ON kaizen_pm_equipment_types FOR INSERT TO authenticated
  WITH CHECK (
    company_id IN (SELECT kaizen_user_company_ids())
    AND EXISTS (SELECT 1 FROM kaizen_profiles p WHERE p.id = auth.uid() AND p.role = 'super_admin')
  );
CREATE POLICY kpet_update ON kaizen_pm_equipment_types FOR UPDATE TO authenticated
  USING (
    company_id IN (SELECT kaizen_user_company_ids())
    AND EXISTS (SELECT 1 FROM kaizen_profiles p WHERE p.id = auth.uid() AND p.role = 'super_admin')
  );
CREATE POLICY kpet_delete ON kaizen_pm_equipment_types FOR DELETE TO authenticated
  USING (
    company_id IN (SELECT kaizen_user_company_ids())
    AND EXISTS (SELECT 1 FROM kaizen_profiles p WHERE p.id = auth.uid() AND p.role = 'super_admin')
  );

NOTIFY pgrst, 'reload schema';
