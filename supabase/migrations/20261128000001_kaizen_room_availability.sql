-- Separate snapshot so uploading R052 cannot overwrite daily revenue reports.
CREATE TABLE IF NOT EXISTS public.kaizen_room_availability (
  company_id uuid PRIMARY KEY REFERENCES public.kaizen_companies(id) ON DELETE CASCADE,
  report_date date NOT NULL,
  report jsonb NOT NULL,
  uploaded_by uuid REFERENCES public.kaizen_profiles(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.kaizen_room_availability ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS kzn_room_availability_select ON public.kaizen_room_availability;
CREATE POLICY kzn_room_availability_select ON public.kaizen_room_availability FOR SELECT TO authenticated
  USING (company_id IN (SELECT kaizen_user_company_ids()));
DROP POLICY IF EXISTS kzn_room_availability_insert ON public.kaizen_room_availability;
CREATE POLICY kzn_room_availability_insert ON public.kaizen_room_availability FOR INSERT TO authenticated
  WITH CHECK (company_id IN (SELECT kaizen_user_company_ids()) AND (kaizen_current_role() IN ('super_admin','manager') OR (kaizen_current_role()='staff' AND kaizen_current_dept()='front_office')));
DROP POLICY IF EXISTS kzn_room_availability_update ON public.kaizen_room_availability;
CREATE POLICY kzn_room_availability_update ON public.kaizen_room_availability FOR UPDATE TO authenticated
  USING (company_id IN (SELECT kaizen_user_company_ids()) AND (kaizen_current_role() IN ('super_admin','manager') OR (kaizen_current_role()='staff' AND kaizen_current_dept()='front_office')))
  WITH CHECK (company_id IN (SELECT kaizen_user_company_ids()) AND (kaizen_current_role() IN ('super_admin','manager') OR (kaizen_current_role()='staff' AND kaizen_current_dept()='front_office')));
GRANT SELECT, INSERT, UPDATE ON public.kaizen_room_availability TO authenticated;
NOTIFY pgrst, 'reload schema';
