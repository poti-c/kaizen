-- Denormalised subscription end date so the hotel app can show a countdown and
-- "pause add-ons when the subscription lapses". Kept in sync by the console
-- (add_invoice) when a payment is recorded.
ALTER TABLE kaizen_companies ADD COLUMN IF NOT EXISTS subscription_end date;

-- Self-serve 7-day trial of the Preventive Maintenance add-on. Top Management
-- only, once per company. Stores a trial-until date + a used flag in addons.
CREATE OR REPLACE FUNCTION kaizen_start_pms_trial()
RETURNS date LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_company uuid; v_addons jsonb; v_until date;
BEGIN
  SELECT company_id INTO v_company FROM kaizen_profiles
   WHERE id = auth.uid() AND role = 'super_admin' AND company_id IS NOT NULL;
  IF v_company IS NULL THEN RAISE EXCEPTION 'Only Top Management can start a trial'; END IF;

  SELECT COALESCE(addons, '{}'::jsonb) INTO v_addons FROM kaizen_companies WHERE id = v_company;
  IF (v_addons->>'pms') = 'true' THEN RAISE EXCEPTION 'Preventive Maintenance is already active'; END IF;
  IF (v_addons ? 'pms_trial_used') THEN RAISE EXCEPTION 'The Preventive Maintenance trial has already been used'; END IF;

  v_until := CURRENT_DATE + 7;
  UPDATE kaizen_companies
     SET addons = v_addons || jsonb_build_object('pms_trial_until', v_until::text, 'pms_trial_used', true)
   WHERE id = v_company;
  RETURN v_until;
END $$;

REVOKE EXECUTE ON FUNCTION kaizen_start_pms_trial() FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION kaizen_start_pms_trial() TO authenticated;

NOTIFY pgrst, 'reload schema';
