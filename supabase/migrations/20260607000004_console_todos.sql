-- Admin Console To-Do / Suggestions list (stored on the single settings row).
ALTER TABLE kaizen_console_settings ADD COLUMN IF NOT EXISTS todos jsonb NOT NULL DEFAULT '[]'::jsonb;

-- Seed with the deferred suggestions (only if empty).
UPDATE kaizen_console_settings SET todos = '[
  {"id":"t1","text":"Enable Resend so receipts auto-email to clients (set RESEND_API_KEY).","done":false},
  {"id":"t2","text":"Verify nnr-solutions.com in Resend for a branded sender (receipts@nnr-solutions.com).","done":false},
  {"id":"t3","text":"Enable SlipOK for instant PromptPay verification (SLIPOK_API_KEY + SLIPOK_BRANCH_ID).","done":false},
  {"id":"t4","text":"Add PDF receipt attachments (after Resend is live).","done":false},
  {"id":"t5","text":"Make the app Packages page read live prices from Products (currently hardcoded).","done":false},
  {"id":"t6","text":"Translate the Packages & Expansions page to Thai.","done":false},
  {"id":"t7","text":"Broader Console notification centre for non-billing events.","done":false}
]'::jsonb
WHERE id = true AND (todos IS NULL OR todos = '[]'::jsonb);

NOTIFY pgrst, 'reload schema';
