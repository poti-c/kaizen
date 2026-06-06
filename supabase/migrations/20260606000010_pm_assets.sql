-- Preventive Maintenance: registered assets/equipment with a maintenance cycle.
CREATE TABLE IF NOT EXISTS kaizen_pm_assets (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id            uuid NOT NULL REFERENCES kaizen_companies(id) ON DELETE CASCADE,
  name                  text NOT NULL,
  type_id               uuid REFERENCES kaizen_pm_equipment_types(id) ON DELETE SET NULL,
  location              text,
  serial_no             text,
  model                 text,
  department            text,
  pic_id                uuid REFERENCES kaizen_profiles(id) ON DELETE SET NULL,
  freq_unit             text NOT NULL DEFAULT 'month' CHECK (freq_unit IN ('day','week','month','year')),
  freq_interval         int  NOT NULL DEFAULT 1,
  checklist             jsonb NOT NULL DEFAULT '[]'::jsonb,
  last_maintenance_date date,
  next_maintenance_date date,
  est_minutes           int,
  notes                 text,
  is_active             boolean NOT NULL DEFAULT true,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS kaizen_pm_assets_company_idx ON kaizen_pm_assets (company_id);
CREATE INDEX IF NOT EXISTS kaizen_pm_assets_next_idx ON kaizen_pm_assets (next_maintenance_date);

ALTER TABLE kaizen_pm_assets ENABLE ROW LEVEL SECURITY;

-- Read: any member of the company.
CREATE POLICY kpa_select ON kaizen_pm_assets FOR SELECT TO authenticated
  USING (company_id IN (SELECT kaizen_user_company_ids()));

-- Manage: Top Management and managers of the company.
CREATE POLICY kpa_insert ON kaizen_pm_assets FOR INSERT TO authenticated
  WITH CHECK (
    company_id IN (SELECT kaizen_user_company_ids())
    AND EXISTS (SELECT 1 FROM kaizen_profiles p WHERE p.id = auth.uid() AND p.role IN ('super_admin','manager'))
  );
CREATE POLICY kpa_update ON kaizen_pm_assets FOR UPDATE TO authenticated
  USING (
    company_id IN (SELECT kaizen_user_company_ids())
    AND EXISTS (SELECT 1 FROM kaizen_profiles p WHERE p.id = auth.uid() AND p.role IN ('super_admin','manager'))
  );
CREATE POLICY kpa_delete ON kaizen_pm_assets FOR DELETE TO authenticated
  USING (
    company_id IN (SELECT kaizen_user_company_ids())
    AND EXISTS (SELECT 1 FROM kaizen_profiles p WHERE p.id = auth.uid() AND p.role IN ('super_admin','manager'))
  );

NOTIFY pgrst, 'reload schema';
