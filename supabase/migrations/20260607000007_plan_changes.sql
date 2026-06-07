-- Plan-change history → powers the Console conversion-rate breakdown
-- (Trial→Gold, Trial→Premium, Gold→Premium).
CREATE TABLE IF NOT EXISTS kaizen_plan_changes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid REFERENCES kaizen_companies(id) ON DELETE CASCADE,
  from_plan   text,
  to_plan     text NOT NULL,
  source      text NOT NULL DEFAULT 'console',   -- 'console' | 'payment' | 'backfill'
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS kaizen_plan_changes_company_idx ON kaizen_plan_changes (company_id);
CREATE INDEX IF NOT EXISTS kaizen_plan_changes_created_idx ON kaizen_plan_changes (created_at DESC);

ALTER TABLE kaizen_plan_changes ENABLE ROW LEVEL SECURITY;

-- The Console writes/reads with the service-role key (bypasses RLS).
-- App users may read their own company's history.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'kaizen_plan_changes' AND policyname = 'kpc_app_read') THEN
    EXECUTE 'CREATE POLICY kpc_app_read ON kaizen_plan_changes FOR SELECT TO authenticated USING (company_id IN (SELECT kaizen_user_company_ids()))';
  END IF;
END $$;

-- One-time backfill: clients already on a paid tier are recorded as having
-- converted from Trial (we can't reconstruct an intermediate Gold step, so
-- premium clients count as Trial→Premium). Future changes are logged precisely.
INSERT INTO kaizen_plan_changes (company_id, from_plan, to_plan, source, created_at)
SELECT id, 'trial', plan, 'backfill', COALESCE(created_at, now())
FROM kaizen_companies
WHERE plan IN ('gold', 'premium')
  AND NOT EXISTS (SELECT 1 FROM kaizen_plan_changes pc WHERE pc.company_id = kaizen_companies.id);

NOTIFY pgrst, 'reload schema';
