-- KaizenPay-2: slip dedup keyed only on sha256(proof data-URL) scoped per company.
-- Re-encoding / re-screenshotting the same slip changes the hash, and a super_admin
-- linked to several companies could submit one slip per company — SlipOK still reads
-- the same bank transaction each time, so one transfer auto-activated repeatedly.
--
-- Record SlipOK's bank transaction reference (transRef) and make it unique ACROSS
-- ALL companies. kaizen-pay refuses auto-activation (leaves the submission pending
-- for manual review) when the transRef has already been used. Partial index so
-- legacy / unverified rows (NULL) never collide.
ALTER TABLE kaizen_payment_submissions ADD COLUMN IF NOT EXISTS trans_ref text;

CREATE UNIQUE INDEX IF NOT EXISTS kps_trans_ref_uidx
  ON kaizen_payment_submissions (trans_ref)
  WHERE trans_ref IS NOT NULL;

NOTIFY pgrst, 'reload schema';
