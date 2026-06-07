-- Console notifications feed (client activity surfaced to the admin console).
CREATE TABLE IF NOT EXISTS kaizen_console_notifications (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type        text NOT NULL,
  company_id  uuid REFERENCES kaizen_companies(id) ON DELETE CASCADE,
  title       text NOT NULL,
  body        text,
  read        boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS kaizen_console_notifications_created_idx ON kaizen_console_notifications (created_at DESC);
ALTER TABLE kaizen_console_notifications ENABLE ROW LEVEL SECURITY;
-- No policy: only the service-role Console can read/write (it bypasses RLS).

-- PMS 7-day trial: also drop a notification into the console feed.
CREATE OR REPLACE FUNCTION public.kaizen_start_pms_trial()
 RETURNS date
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE v_company uuid; v_addons jsonb; v_until date; v_name text;
BEGIN
  SELECT company_id INTO v_company FROM kaizen_profiles
   WHERE id = auth.uid() AND role = 'super_admin' AND company_id IS NOT NULL;
  IF v_company IS NULL THEN RAISE EXCEPTION 'Only Top Management can start a trial'; END IF;
  SELECT COALESCE(addons, '{}'::jsonb) INTO v_addons FROM kaizen_companies WHERE id = v_company;
  IF (v_addons->>'pms') = 'true' THEN RAISE EXCEPTION 'Preventive Maintenance is already active'; END IF;
  IF (v_addons ? 'pms_trial_used') THEN RAISE EXCEPTION 'The Preventive Maintenance trial has already been used'; END IF;
  v_until := CURRENT_DATE + 7;
  UPDATE kaizen_companies SET addons = v_addons || jsonb_build_object('pms_trial_until', v_until::text, 'pms_trial_used', true) WHERE id = v_company;
  SELECT name INTO v_name FROM kaizen_companies WHERE id = v_company;
  INSERT INTO kaizen_console_notifications (type, company_id, title, body)
  VALUES ('pms_trial_started', v_company, 'PMS free trial started',
          COALESCE(v_name,'A client') || ' started a 7-day Preventive Maintenance trial (ends ' || v_until::text || ').');
  RETURN v_until;
END $function$;

NOTIFY pgrst, 'reload schema';
