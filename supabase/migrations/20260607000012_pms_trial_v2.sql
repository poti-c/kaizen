-- Fix: "Try free for 7 days" did nothing because the trial RPC always targeted
-- the caller's HOME company (ignoring the active/selected company). Re-create it
-- to accept the target company id, authorised via kaizen_member_company_ids().
DROP FUNCTION IF EXISTS public.kaizen_start_pms_trial();

CREATE OR REPLACE FUNCTION public.kaizen_start_pms_trial(p_company_id uuid DEFAULT NULL)
 RETURNS date
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE v_company uuid; v_addons jsonb; v_until date; v_name text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM kaizen_profiles WHERE id = auth.uid() AND role = 'super_admin') THEN
    RAISE EXCEPTION 'Only Top Management can start a trial';
  END IF;
  IF p_company_id IS NOT NULL THEN
    IF p_company_id NOT IN (SELECT kaizen_member_company_ids()) THEN
      RAISE EXCEPTION 'Not authorised for this company';
    END IF;
    v_company := p_company_id;
  ELSE
    SELECT company_id INTO v_company FROM kaizen_profiles WHERE id = auth.uid() AND company_id IS NOT NULL;
  END IF;
  IF v_company IS NULL THEN RAISE EXCEPTION 'No company to start a trial for'; END IF;

  SELECT COALESCE(addons, '{}'::jsonb) INTO v_addons FROM kaizen_companies WHERE id = v_company;
  IF (v_addons->>'pms') = 'true' THEN RAISE EXCEPTION 'Preventive Maintenance is already active'; END IF;
  IF (v_addons ? 'pms_trial_used') THEN RAISE EXCEPTION 'The Preventive Maintenance trial has already been used'; END IF;

  v_until := CURRENT_DATE + 7;
  UPDATE kaizen_companies
     SET addons = v_addons || jsonb_build_object('pms_trial_until', v_until::text, 'pms_trial_used', true)
   WHERE id = v_company;

  SELECT name INTO v_name FROM kaizen_companies WHERE id = v_company;
  INSERT INTO kaizen_console_notifications (type, company_id, title, body)
  VALUES ('pms_trial_started', v_company, 'PMS free trial started',
          COALESCE(v_name, 'A client') || ' started a 7-day Preventive Maintenance trial (ends ' || v_until::text || ').');
  RETURN v_until;
END $function$;

REVOKE EXECUTE ON FUNCTION public.kaizen_start_pms_trial(uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.kaizen_start_pms_trial(uuid) TO authenticated;

NOTIFY pgrst, 'reload schema';
