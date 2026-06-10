-- Thai tax-invoice billing fields for client companies (buyer side).
-- office_type: 'head_office' (สำนักงานใหญ่) or 'branch' (สาขา) — required on a full tax invoice.
-- branch_code: 5-digit branch code when office_type='branch'.
-- billing_address: structured Thai address parts {house_no, soi, road, subdistrict, district, province, postcode, country}.
-- The existing free-text `address` column is kept as a composed one-line string for display/printing.
ALTER TABLE kaizen_companies
  ADD COLUMN IF NOT EXISTS office_type text NOT NULL DEFAULT 'head_office',
  ADD COLUMN IF NOT EXISTS branch_code text,
  ADD COLUMN IF NOT EXISTS billing_address jsonb NOT NULL DEFAULT '{}'::jsonb;
