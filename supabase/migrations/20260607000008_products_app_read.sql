-- Let the hotel app read active products so the Packages page shows live
-- prices/names from the Console's Products table (instead of hardcoded values).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'kaizen_products' AND policyname = 'kprod_app_read') THEN
    EXECUTE 'CREATE POLICY kprod_app_read ON kaizen_products FOR SELECT TO authenticated USING (is_active = true)';
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
