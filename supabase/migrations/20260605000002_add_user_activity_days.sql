-- One row per user per active day (cheap activity log feeding engagement scores).
CREATE TABLE IF NOT EXISTS public.kaizen_user_activity (
  user_id     uuid NOT NULL REFERENCES public.kaizen_profiles(id) ON DELETE CASCADE,
  active_date date NOT NULL,
  company_id  uuid REFERENCES public.kaizen_companies(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, active_date)
);
ALTER TABLE public.kaizen_user_activity ENABLE ROW LEVEL SECURITY;

CREATE POLICY kzn_uact_insert ON public.kaizen_user_activity
  FOR INSERT WITH CHECK (user_id = auth.uid());

CREATE POLICY kzn_uact_select ON public.kaizen_user_activity
  FOR SELECT USING (
    user_id = auth.uid()
    OR company_id IN (SELECT public.kaizen_user_company_ids())
  );
