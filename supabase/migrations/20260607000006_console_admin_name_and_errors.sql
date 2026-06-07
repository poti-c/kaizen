-- Task 1: personalized greeting — display name on console admins.
ALTER TABLE kaizen_console_admins ADD COLUMN IF NOT EXISTS display_name text;

-- Task 2: client-app error reporter — real runtime errors from the hotel app,
-- surfaced in the Console under Audit Logs → Errors.
CREATE TABLE IF NOT EXISTS kaizen_error_log (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid REFERENCES kaizen_companies(id) ON DELETE SET NULL,
  user_id     uuid,
  source      text NOT NULL DEFAULT 'app',     -- 'window' | 'promise' | 'react' | 'app'
  message     text NOT NULL,
  detail      jsonb NOT NULL DEFAULT '{}'::jsonb,
  url         text,
  user_agent  text,
  resolved    boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS kaizen_error_log_created_idx ON kaizen_error_log (created_at DESC);
CREATE INDEX IF NOT EXISTS kaizen_error_log_company_idx ON kaizen_error_log (company_id);

ALTER TABLE kaizen_error_log ENABLE ROW LEVEL SECURITY;

-- Authenticated hotel-app users may log errors for their own company (or no company).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'kaizen_error_log' AND policyname = 'kel_app_insert') THEN
    EXECUTE 'CREATE POLICY kel_app_insert ON kaizen_error_log FOR INSERT TO authenticated WITH CHECK (company_id IS NULL OR company_id IN (SELECT kaizen_user_company_ids()))';
  END IF;
END $$;

-- (Console reads/writes the table with the service-role key, which bypasses RLS.)

NOTIFY pgrst, 'reload schema';
