-- Allow users explicitly named In Charge (PIC) to SEE and UPDATE (resolve) a
-- case even when it belongs to a different department than their own.
-- Managers / super_admin already have cross-department access; this closes the
-- gap for staff (and any role) who are added to a case's pic_ids.

DROP POLICY IF EXISTS "kzn_cases_select" ON kaizen_cases;
CREATE POLICY "kzn_cases_select" ON kaizen_cases FOR SELECT USING (
  kaizen_current_role() IN ('super_admin','manager')
  OR (kaizen_current_role() = 'staff' AND department = kaizen_current_dept())
  OR auth.uid() = ANY(COALESCE(pic_ids, '{}'::uuid[]))
  OR auth.uid() = person_in_charge
);

DROP POLICY IF EXISTS "kzn_cases_update" ON kaizen_cases;
CREATE POLICY "kzn_cases_update" ON kaizen_cases FOR UPDATE USING (
  kaizen_current_role() IN ('super_admin','manager')
  OR (kaizen_current_role() = 'staff' AND department = kaizen_current_dept())
  OR auth.uid() = ANY(COALESCE(pic_ids, '{}'::uuid[]))
  OR auth.uid() = person_in_charge
);
