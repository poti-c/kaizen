-- Na Nirand Kaizen — Multi-Company Support
-- Adds kaizen_companies + kaizen_super_admin_companies tables
-- Adds company_id to profiles, cases, and settings

-- ============================================================
-- COMPANIES TABLE
-- ============================================================
CREATE TABLE IF NOT EXISTS kaizen_companies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  logo_url TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed Na Nirand as the first company (fixed UUID so references are stable)
INSERT INTO kaizen_companies (id, name, slug)
VALUES ('a0000000-0000-0000-0000-000000000001', 'Na Nirand', 'na-nirand')
ON CONFLICT (slug) DO NOTHING;

-- ============================================================
-- SUPER ADMIN → COMPANIES MAPPING
-- ============================================================
CREATE TABLE IF NOT EXISTS kaizen_super_admin_companies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  super_admin_id UUID NOT NULL REFERENCES kaizen_profiles(id) ON DELETE CASCADE,
  company_id UUID NOT NULL REFERENCES kaizen_companies(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (super_admin_id, company_id)
);

-- ============================================================
-- ADD company_id TO EXISTING TABLES
-- ============================================================
ALTER TABLE kaizen_profiles ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES kaizen_companies(id);
ALTER TABLE kaizen_cases    ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES kaizen_companies(id);
ALTER TABLE kaizen_settings ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES kaizen_companies(id);

-- Settings: change unique constraint from (key) to (key, company_id)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'kaizen_settings_key_key' AND conrelid = 'kaizen_settings'::regclass
  ) THEN
    ALTER TABLE kaizen_settings DROP CONSTRAINT kaizen_settings_key_key;
  END IF;
END $$;

ALTER TABLE kaizen_settings
  ADD CONSTRAINT kaizen_settings_key_company_key UNIQUE (key, company_id);

-- ============================================================
-- SEED: point all existing data to Na Nirand
-- ============================================================
UPDATE kaizen_profiles SET company_id = 'a0000000-0000-0000-0000-000000000001' WHERE company_id IS NULL;
UPDATE kaizen_cases    SET company_id = 'a0000000-0000-0000-0000-000000000001' WHERE company_id IS NULL;
UPDATE kaizen_settings SET company_id = 'a0000000-0000-0000-0000-000000000001' WHERE company_id IS NULL;

-- Register all existing super admins to Na Nirand
INSERT INTO kaizen_super_admin_companies (super_admin_id, company_id)
SELECT id, 'a0000000-0000-0000-0000-000000000001'
FROM kaizen_profiles WHERE role = 'super_admin'
ON CONFLICT (super_admin_id, company_id) DO NOTHING;

-- ============================================================
-- RLS
-- ============================================================
ALTER TABLE kaizen_companies ENABLE ROW LEVEL SECURITY;
CREATE POLICY "kzn_companies_select" ON kaizen_companies FOR SELECT USING (true);
CREATE POLICY "kzn_companies_insert" ON kaizen_companies FOR INSERT WITH CHECK (kaizen_current_role() = 'super_admin');
CREATE POLICY "kzn_companies_update" ON kaizen_companies FOR UPDATE USING (kaizen_current_role() = 'super_admin');

ALTER TABLE kaizen_super_admin_companies ENABLE ROW LEVEL SECURITY;
CREATE POLICY "kzn_sa_cos_select" ON kaizen_super_admin_companies
  FOR SELECT USING (super_admin_id = auth.uid() OR kaizen_current_role() = 'super_admin');
CREATE POLICY "kzn_sa_cos_insert" ON kaizen_super_admin_companies
  FOR INSERT WITH CHECK (kaizen_current_role() = 'super_admin');
CREATE POLICY "kzn_sa_cos_delete" ON kaizen_super_admin_companies
  FOR DELETE USING (kaizen_current_role() = 'super_admin');
