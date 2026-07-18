-- Backfill the CREATE TABLE statements for the Console admin subsystem.
--
-- These four tables were created directly in the live project and never
-- captured here, yet eight later migrations ALTER them:
--   20260606000003_console_settings_logo.sql            (first reference)
--   20260606000004_console_settings_signatory.sql
--   20260606000005_console_settings_contact.sql
--   20260607000002_payments_phase2.sql
--   20260607000004_console_todos.sql
--   20260607000005_auto_fix.sql
--   20260607000006_console_admin_name_and_errors.sql
--   20260610000004_console_settings_structured_billing_address.sql
-- A rebuild from migrations therefore failed at the first of those.
--
-- This file is timestamped to run BEFORE all of them. Each table is created in
-- its ORIGINAL shape — the columns those later migrations add are deliberately
-- omitted so the existing history still does its job (including the UPDATE
-- statements that seed signatory defaults and the todo list). The live column
-- ordinal order confirms this reconstruction: it matches the migration order
-- exactly.
--
-- Everything below is `if not exists` / idempotent, so this is a no-op against
-- the live project.

-- ── Console admin accounts ───────────────────────────────────────────────────
-- Separate from Supabase Auth: the Console has its own username/password login,
-- verified in an edge function against password_hash.
-- (display_name is added later by 20260607000006.)
CREATE TABLE IF NOT EXISTS kaizen_console_admins (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username      text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  email         text,
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- ── Console audit trail ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS kaizen_console_audit (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  action     text NOT NULL,
  detail     jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip         text,
  success    boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS kaizen_console_audit_created_idx
  ON kaizen_console_audit (created_at DESC);

-- ── Console login throttling ─────────────────────────────────────────────────
-- One row per source IP; the edge function bumps attempts and sets locked_until.
CREATE TABLE IF NOT EXISTS kaizen_console_login_attempts (
  ip           text PRIMARY KEY,
  attempts     integer NOT NULL DEFAULT 0,
  locked_until timestamptz,
  last_attempt timestamptz NOT NULL DEFAULT now()
);

-- ── Console settings (singleton) ─────────────────────────────────────────────
-- Vendor-side (NNR) identity used on invoices and receipts. `id boolean PRIMARY
-- KEY CHECK (id)` is the singleton trick: only one row, always id = true.
-- (Everything from logo_url onward is added by the later migrations listed above.)
CREATE TABLE IF NOT EXISTS kaizen_console_settings (
  id           boolean PRIMARY KEY DEFAULT true CHECK (id),
  company_name text,
  office_type  text NOT NULL DEFAULT 'head_office'
                 CHECK (office_type IN ('head_office', 'branch')),
  branch_name  text,
  address      text,
  tax_id       text,
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- Materialise the singleton row. Later migrations seed their defaults with
-- `UPDATE ... WHERE id = true`, which would silently do nothing on an empty
-- table, so the row has to exist by this point.
INSERT INTO kaizen_console_settings (id) VALUES (true)
  ON CONFLICT (id) DO NOTHING;

-- ── Row level security ───────────────────────────────────────────────────────
-- All four are RLS-enabled. Only kaizen_console_settings gets a policy (added
-- by 20260607000002_payments_phase2.sql: authenticated may read, so the app can
-- print vendor details on invoices).
--
-- The other three intentionally have NO policy. RLS with no policy denies every
-- request from anon/authenticated; the Console reaches them exclusively through
-- edge functions using the service_role key, which bypasses RLS. Admin password
-- hashes, the audit trail and lockout state must never be client-readable.
ALTER TABLE kaizen_console_admins         ENABLE ROW LEVEL SECURITY;
ALTER TABLE kaizen_console_audit          ENABLE ROW LEVEL SECURITY;
ALTER TABLE kaizen_console_login_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE kaizen_console_settings       ENABLE ROW LEVEL SECURITY;

-- Supabase grants anon/authenticated on new public tables by default. Live has
-- no such grant on these two, so revoke it to match — defence in depth behind
-- the no-policy RLS above.
REVOKE ALL ON kaizen_console_audit          FROM anon, authenticated;
REVOKE ALL ON kaizen_console_login_attempts FROM anon, authenticated;

NOTIFY pgrst, 'reload schema';
