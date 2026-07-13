-- Allow all managers (any department) to delete cases, not just Super Admins.
--
-- Previously kzn_cases_delete restricted DELETE on kaizen_cases to super_admin.
-- Managers now get the same delete capability, still scoped to their own
-- company via kaizen_user_company_ids(). Child rows (photos, timeline,
-- notifications) are removed by ON DELETE CASCADE, so no extra child policies
-- are needed.
DROP POLICY IF EXISTS "kzn_cases_delete" ON kaizen_cases;
CREATE POLICY "kzn_cases_delete" ON kaizen_cases
  FOR DELETE
  USING (
    kaizen_current_role() IN ('super_admin', 'manager')
    AND company_id IN (SELECT kaizen_user_company_ids())
  );
