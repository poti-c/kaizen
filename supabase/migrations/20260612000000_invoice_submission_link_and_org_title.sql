-- Link recorded payments back to the client submission that created them,
-- so deleting one keeps the Payments inbox in sync with Transaction History.
ALTER TABLE kaizen_invoices ADD COLUMN IF NOT EXISTS submission_id uuid;

-- Display name of the client's app/organisation. Shown in the console and
-- client app UI; intentionally NOT used on invoices / receipts / tax invoices,
-- which always carry the legal company name.
ALTER TABLE kaizen_companies ADD COLUMN IF NOT EXISTS org_title text;
