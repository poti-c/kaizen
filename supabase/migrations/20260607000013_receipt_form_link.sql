-- Link an issued tax invoice/receipt (generated form) back to its invoice, and
-- track a separate "sent/delivered" state.
ALTER TABLE kaizen_invoices ADD COLUMN IF NOT EXISTS receipt_form_id uuid;
ALTER TABLE kaizen_invoices ADD COLUMN IF NOT EXISTS receipt_sent     boolean NOT NULL DEFAULT false;
ALTER TABLE kaizen_invoices ADD COLUMN IF NOT EXISTS receipt_sent_at  timestamptz;
NOTIFY pgrst, 'reload schema';
