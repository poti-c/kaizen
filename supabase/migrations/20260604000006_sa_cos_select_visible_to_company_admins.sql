-- A super admin should see cross-company grants not only for themselves, but
-- for any company they have access to — so a company's owner can see which
-- other super admins (guests) have been granted access to that company.
alter policy kzn_sa_cos_select on kaizen_super_admin_companies
  using (
    super_admin_id = auth.uid()
    or company_id in (select kaizen_user_company_ids())
  );
