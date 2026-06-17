-- Idempotency for payment submissions: the same uploaded slip (proof) must not be
-- able to create multiple approved submissions / duplicate invoices / repeated plan
-- activations on a retry, double-submit, or deliberate replay. Key on a hash of the
-- proof data URL, scoped per company. Partial index so legacy rows (NULL hash) and
-- any future hash-less inserts don't collide.

ALTER TABLE kaizen_payment_submissions ADD COLUMN IF NOT EXISTS proof_hash text;

CREATE UNIQUE INDEX IF NOT EXISTS kps_company_proofhash_uidx
  ON kaizen_payment_submissions (company_id, proof_hash)
  WHERE proof_hash IS NOT NULL;
