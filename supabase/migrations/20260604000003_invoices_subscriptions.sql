-- Console-managed subscription invoices + private proof bucket.
-- Each payment = a 1-year subscription period (period_end = payment_date + 1yr).
-- Applied to project znxqmurhjtyfsotcorfj on 2026-06-04.

CREATE TABLE IF NOT EXISTS kaizen_invoices (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   UUID NOT NULL REFERENCES kaizen_companies(id) ON DELETE CASCADE,
  payee        TEXT,
  amount       NUMERIC(12,2),
  currency     TEXT NOT NULL DEFAULT 'THB',
  payment_date DATE NOT NULL,
  period_start DATE NOT NULL,
  period_end   DATE NOT NULL,
  proof_path   TEXT,
  notes        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS kaizen_invoices_company_idx ON kaizen_invoices (company_id, payment_date DESC);
ALTER TABLE kaizen_invoices ENABLE ROW LEVEL SECURITY;  -- no policies → console/service-role only
REVOKE ALL ON kaizen_invoices FROM anon, authenticated;

-- Private bucket; proofs are served only via short-lived signed URLs from the edge function.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('kaizen-invoices', 'kaizen-invoices', false, 10485760, ARRAY['image/jpeg','image/png','image/webp'])
ON CONFLICT (id) DO NOTHING;
