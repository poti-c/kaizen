-- Seller (NNR) structured billing address + branch code for tax invoices.
ALTER TABLE kaizen_console_settings
  ADD COLUMN IF NOT EXISTS branch_code text,
  ADD COLUMN IF NOT EXISTS billing_address jsonb NOT NULL DEFAULT '{}'::jsonb;
