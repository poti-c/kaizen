-- Hard-enforce company suspension at the database (RLS) layer.
--
-- Membership: companies the user belongs to (home + cross-grants), INCLUDING
-- suspended ones. Used only so a user can still read their own company row to
-- learn it's suspended.
create or replace function public.kaizen_member_company_ids()
returns setof uuid
language sql stable security definer
set search_path = public
as $$
  select company_id from public.kaizen_profiles
    where id = auth.uid() and company_id is not null
  union
  select company_id from public.kaizen_super_admin_companies
    where super_admin_id = auth.uid()
$$;

-- Accessible companies = membership filtered to ACTIVE only. Every data-table
-- RLS policy uses this, so suspended companies' data becomes inaccessible to
-- all app users. (The console uses the service role and bypasses RLS.)
create or replace function public.kaizen_user_company_ids()
returns setof uuid
language sql stable security definer
set search_path = public
as $$
  select c.id from public.kaizen_companies c
  where c.is_active
    and c.id in (select public.kaizen_member_company_ids())
$$;

-- Let users still SELECT their own company row even when suspended, so the app
-- can detect suspension and show a clear message (data tables stay blocked).
alter policy kzn_companies_select on public.kaizen_companies
  using (id in (select public.kaizen_member_company_ids()));
