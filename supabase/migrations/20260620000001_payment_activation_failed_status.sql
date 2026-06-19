-- Allow 'activation_failed' as a submission status so the edge function can mark
-- submissions that activated SlipOK but failed the downstream plan/addon update.
-- This prevents the slip-free dedup guard from permanently blocking retries.
ALTER TABLE kaizen_payment_submissions
  DROP CONSTRAINT IF EXISTS kaizen_payment_submissions_status_check;

ALTER TABLE kaizen_payment_submissions
  ADD CONSTRAINT kaizen_payment_submissions_status_check
  CHECK (status IN ('pending', 'approved', 'rejected', 'activation_failed'));
