-- Tighten case deletion (security): managers may only delete cases that belong
-- to them or their department, instead of any case in the company.
--
-- A manager (role = 'manager') may DELETE a case when ANY of:
--   * they are an HR manager (department = 'human_resource') — company-wide, HR
--     retains its existing cross-department oversight;
--   * they created the case themselves (created_by = them);
--   * the case's primary department is their department;
--   * their department is among the case's assigned_departments;
--   * the case was created by a user in their department (their staff raised it).
-- Super Admins (Top Management) keep unrestricted delete across their company.
-- Everything stays scoped to the caller's own active company.
--
-- Child rows (photos, timeline, comments, notifications) are removed by
-- ON DELETE CASCADE, so no extra child policies are needed.
DROP POLICY IF EXISTS "kzn_cases_delete" ON kaizen_cases;
CREATE POLICY "kzn_cases_delete" ON kaizen_cases
  FOR DELETE
  USING (
    company_id IN (SELECT kaizen_user_company_ids())
    AND (
      kaizen_current_role() = 'super_admin'
      OR (
        kaizen_current_role() = 'manager'
        AND (
          kaizen_current_dept() = 'human_resource'
          OR created_by = auth.uid()
          OR department = kaizen_current_dept()
          OR kaizen_current_dept() = ANY (assigned_departments)
          OR EXISTS (
            SELECT 1 FROM kaizen_profiles cp
            WHERE cp.id = kaizen_cases.created_by
              AND cp.department = kaizen_current_dept()
          )
        )
      )
    )
  );
