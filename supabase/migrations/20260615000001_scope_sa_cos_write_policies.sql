-- Tenant-isolation hardening: a super_admin may only LINK/UNLINK an admin to a company
-- they actually manage (their own home company + companies granted to them), not any
-- arbitrary company id. Previously the insert/delete policies checked only the caller's
-- role, letting any super_admin cross-link admins across tenants.
-- (Company creation links the owner via the service-role edge function, which bypasses RLS,
--  so this does not affect first-admin bootstrap.)

DROP POLICY IF EXISTS "kzn_sa_cos_insert" ON kaizen_super_admin_companies;
CREATE POLICY "kzn_sa_cos_insert" ON kaizen_super_admin_companies
  FOR INSERT WITH CHECK (
    kaizen_current_role() = 'super_admin'
    AND company_id IN (SELECT kaizen_user_company_ids())
  );

DROP POLICY IF EXISTS "kzn_sa_cos_delete" ON kaizen_super_admin_companies;
CREATE POLICY "kzn_sa_cos_delete" ON kaizen_super_admin_companies
  FOR DELETE USING (
    kaizen_current_role() = 'super_admin'
    AND company_id IN (SELECT kaizen_user_company_ids())
  );
