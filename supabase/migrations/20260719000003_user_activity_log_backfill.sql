-- Backfill the CREATE TABLE for kaizen_user_activity_log.
--
-- Created directly in the live project and never captured here, so a rebuild
-- from migrations produced no such table and the Users page failed on both its
-- insert and its select ([src/pages/UsersPage.tsx](src/pages/UsersPage.tsx)).
--
-- Unlike the console tables, no migration references this one, so it carries no
-- ordering constraint and sits at the end of the history. (Note that
-- 20260605000001_add_user_activity_tracking.sql, despite the similar name, is
-- unrelated — it adds last_active_at/last_login_at to kaizen_profiles.)
--
-- Idempotent throughout, so this is a no-op against the live project.

-- Who did what to whom, per company: role changes, deactivations, resets.
CREATE TABLE IF NOT EXISTS kaizen_user_activity_log (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       uuid REFERENCES kaizen_companies(id) ON DELETE CASCADE,
  performed_by     uuid REFERENCES kaizen_profiles(id)  ON DELETE SET NULL,
  target_user_id   uuid REFERENCES kaizen_profiles(id)  ON DELETE SET NULL,
  -- Name snapshot, so history survives the target profile being deleted.
  target_user_name text,
  action           text NOT NULL,
  details          text,
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- The FK constraint names matter: the app embeds the performer through one of
-- them by name, in [src/pages/UsersPage.tsx](src/pages/UsersPage.tsx):
--   .select('*, performer:kaizen_profiles!kaizen_user_activity_log_performed_by_fkey(full_name)')
-- Postgres derives <table>_<column>_fkey, which is exactly what live has, so
-- the inline REFERENCES above reproduce the names without spelling them out.

ALTER TABLE kaizen_user_activity_log ENABLE ROW LEVEL SECURITY;

-- Policies are created only when absent — the same guarded idiom as
-- 20260607000002_payments_phase2.sql. DROP + CREATE would work too, but it
-- would briefly rewrite live policies rather than leaving them untouched.
DO $$
BEGIN
  -- Read: within your own company, super_admins see everything, everyone else
  -- sees only what they themselves did.
  IF NOT EXISTS (SELECT 1 FROM pg_policies
                  WHERE tablename = 'kaizen_user_activity_log'
                    AND policyname = 'kzn_uactlog_select') THEN
    EXECUTE $p$
      CREATE POLICY kzn_uactlog_select ON kaizen_user_activity_log FOR SELECT
        USING (
          company_id IN (SELECT kaizen_user_company_ids())
          AND (kaizen_current_role() = 'super_admin' OR performed_by = auth.uid())
        )$p$;
  END IF;

  -- Write: only in your own company, and only as yourself — no forging the actor.
  IF NOT EXISTS (SELECT 1 FROM pg_policies
                  WHERE tablename = 'kaizen_user_activity_log'
                    AND policyname = 'kzn_uactlog_insert') THEN
    EXECUTE $p$
      CREATE POLICY kzn_uactlog_insert ON kaizen_user_activity_log FOR INSERT
        WITH CHECK (
          company_id IN (SELECT kaizen_user_company_ids())
          AND performed_by = auth.uid()
        )$p$;
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
