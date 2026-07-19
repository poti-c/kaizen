-- Backfill migrations for columns on kaizen_companies and kaizen_profiles that
-- were added directly to the live project and never captured here. A rebuild
-- from migrations produced these tables without them.
--
-- Unlike the kaizen_cases pair, no migration references these columns, so they
-- carry no ordering constraint and sit at the end of the history.
--
-- All definitions match live exactly; `if not exists` makes this a no-op
-- against the live project.

-- ── kaizen_companies ─────────────────────────────────────────────────────────
--   login_code     — per-company code used on the staff sign-in screen
--   contact_*      — primary contact for the account
--   address        — free-text one-line address, composed for display/printing
--                    (the structured parts live in billing_address, added by
--                     20260610000003_company_billing_branch_and_structured_address.sql)
--   tax_id         — Thai tax ID, printed on invoices
--   console_notes  — internal admin notes; no app code reads this today
ALTER TABLE kaizen_companies
  ADD COLUMN IF NOT EXISTS login_code text,
  ADD COLUMN IF NOT EXISTS contact_person text,
  ADD COLUMN IF NOT EXISTS contact_phone text,
  ADD COLUMN IF NOT EXISTS contact_email text,
  ADD COLUMN IF NOT EXISTS address text,
  ADD COLUMN IF NOT EXISTS tax_id text,
  ADD COLUMN IF NOT EXISTS console_notes text;

-- ── kaizen_profiles ──────────────────────────────────────────────────────────
--   job_title / position  — free-text role labels shown in the users list
--   must_change_password  — gates the forced /change-password redirect on login
--                           (src/App.tsx, src/components/Layout.tsx)
ALTER TABLE kaizen_profiles
  ADD COLUMN IF NOT EXISTS job_title text,
  ADD COLUMN IF NOT EXISTS position text,
  ADD COLUMN IF NOT EXISTS must_change_password boolean NOT NULL DEFAULT false;

NOTIFY pgrst, 'reload schema';
