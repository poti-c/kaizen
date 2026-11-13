-- Let Front Office staff upload the daily hotel report.
--
-- The report arrives from Front Office every night, so their staff are the
-- ones who will upload it (from the Dashboard's "Upload Hotel Report" card).
-- Managers and super admins keep write access as before; other staff still
-- cannot write these figures.
--
-- Upload is an upsert, so both INSERT and UPDATE need the same rule. DELETE
-- stays super_admin only (unchanged, not touched here).
--
-- kaizen_current_dept() is the existing SECURITY DEFINER helper that reads the
-- caller's own profile department (auth.uid()); no new function is created.
--
-- Idempotent: drops and recreates the two policies.

DROP POLICY IF EXISTS kzn_hotel_daily_insert ON public.kaizen_hotel_daily;
CREATE POLICY kzn_hotel_daily_insert ON public.kaizen_hotel_daily FOR INSERT
  WITH CHECK (
    company_id IN (SELECT kaizen_user_company_ids())
    AND (
      kaizen_current_role() IN ('super_admin', 'manager')
      OR (kaizen_current_role() = 'staff' AND kaizen_current_dept() = 'front_office')
    )
  );

DROP POLICY IF EXISTS kzn_hotel_daily_update ON public.kaizen_hotel_daily;
CREATE POLICY kzn_hotel_daily_update ON public.kaizen_hotel_daily FOR UPDATE
  USING (
    company_id IN (SELECT kaizen_user_company_ids())
    AND (
      kaizen_current_role() IN ('super_admin', 'manager')
      OR (kaizen_current_role() = 'staff' AND kaizen_current_dept() = 'front_office')
    )
  )
  WITH CHECK (
    company_id IN (SELECT kaizen_user_company_ids())
    AND (
      kaizen_current_role() IN ('super_admin', 'manager')
      OR (kaizen_current_role() = 'staff' AND kaizen_current_dept() = 'front_office')
    )
  );

NOTIFY pgrst, 'reload schema';
