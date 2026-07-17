-- Defense-in-depth: enforce COMPANY isolation for kaizen_cases at the database
-- layer, not just via the frontend's .eq('company_id', …) filter.
--
-- The kzn_cases_select / _update / _delete policies match on role + department
-- label, with no company_id clause. Because department labels can collide across
-- tenants (two companies could both have a "kitchen" / "engineering_team"), the
-- DB alone couldn't tell them apart — isolation rested entirely on every case
-- query remembering to add the company filter. The INSERT policy already scopes
-- by company (WITH CHECK), and every PM table enforces this at the DB layer; this
-- brings cases in line for reads/updates/deletes.
--
-- A RESTRICTIVE policy is ANDed with the existing PERMISSIVE ones, so it adds the
-- company guarantee without touching any of the role/department logic. Uses the
-- same kaizen_user_company_ids() helper as the INSERT policy and the PM tables,
-- so it cannot lock out a legitimate user (their own cases always carry a
-- company_id in that set).
CREATE POLICY "kzn_cases_company_isolation" ON kaizen_cases
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (company_id IN (SELECT kaizen_user_company_ids()))
  WITH CHECK (company_id IN (SELECT kaizen_user_company_ids()));
