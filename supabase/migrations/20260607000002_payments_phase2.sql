-- Phase 2: PromptPay billing info, support email, and client payment submissions.

-- Vendor (NNR-Solutions) billing + support fields on the single console settings row.
ALTER TABLE kaizen_console_settings ADD COLUMN IF NOT EXISTS promptpay_id   text;
ALTER TABLE kaizen_console_settings ADD COLUMN IF NOT EXISTS promptpay_name text;
ALTER TABLE kaizen_console_settings ADD COLUMN IF NOT EXISTS promptpay_qr   text;  -- QR image as a data URL
ALTER TABLE kaizen_console_settings ADD COLUMN IF NOT EXISTS support_email  text;

-- Let the hotel app read the vendor's public billing/support info (no secrets here).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'kaizen_console_settings' AND policyname = 'kcs_app_read') THEN
    EXECUTE 'CREATE POLICY kcs_app_read ON kaizen_console_settings FOR SELECT TO authenticated USING (true)';
  END IF;
END $$;

-- Client payment submissions (proof of a PromptPay transfer awaiting review).
CREATE TABLE IF NOT EXISTS kaizen_payment_submissions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL REFERENCES kaizen_companies(id) ON DELETE CASCADE,
  kind          text NOT NULL CHECK (kind IN ('subscription','addon')),
  target        text NOT NULL,            -- plan key ('gold'/'premium') or addon key ('pms')
  target_label  text,
  amount        numeric,
  currency      text DEFAULT 'THB',
  proof_url     text,                      -- payment slip as a data URL
  note          text,
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  submitted_by  uuid REFERENCES kaizen_profiles(id) ON DELETE SET NULL,
  reviewed_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS kps_company_idx ON kaizen_payment_submissions (company_id);
CREATE INDEX IF NOT EXISTS kps_status_idx  ON kaizen_payment_submissions (status);

ALTER TABLE kaizen_payment_submissions ENABLE ROW LEVEL SECURITY;
-- App: members of the company can see their submissions; managers/Top Management submit.
CREATE POLICY kps_select ON kaizen_payment_submissions FOR SELECT TO authenticated
  USING (company_id IN (SELECT kaizen_user_company_ids()));
CREATE POLICY kps_insert ON kaizen_payment_submissions FOR INSERT TO authenticated
  WITH CHECK (
    company_id IN (SELECT kaizen_user_company_ids())
    AND EXISTS (SELECT 1 FROM kaizen_profiles p WHERE p.id = auth.uid() AND p.role IN ('super_admin','manager'))
  );

NOTIFY pgrst, 'reload schema';
