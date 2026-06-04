-- Model 1 multi-tenancy: DB-enforced company isolation via RLS.
-- Helper functions + rewritten policies on every table so a user can only
-- ever read/write rows belonging to a company they are a member of.
-- Applied to project znxqmurhjtyfsotcorfj on 2026-06-04.
-- (Full policy bodies are in the applied migration "tenant_isolation_rls";
--  this file is the canonical record — see Supabase migration history.)

CREATE OR REPLACE FUNCTION kaizen_user_company_ids()
RETURNS SETOF uuid LANGUAGE sql SECURITY DEFINER STABLE AS $$
  SELECT company_id FROM public.kaizen_profiles
    WHERE id = auth.uid() AND company_id IS NOT NULL
  UNION
  SELECT company_id FROM public.kaizen_super_admin_companies
    WHERE super_admin_id = auth.uid()
$$;

CREATE OR REPLACE FUNCTION kaizen_case_company(p_case uuid)
RETURNS uuid LANGUAGE sql SECURITY DEFINER STABLE AS $$
  SELECT company_id FROM public.kaizen_cases WHERE id = p_case
$$;

REVOKE EXECUTE ON FUNCTION kaizen_user_company_ids() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION kaizen_case_company(uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION kaizen_user_company_ids() TO authenticated;
GRANT  EXECUTE ON FUNCTION kaizen_case_company(uuid) TO authenticated;

-- Policies rewritten on: kaizen_profiles, kaizen_cases, kaizen_settings,
-- kaizen_case_photos, kaizen_case_assignments, kaizen_case_timeline,
-- kaizen_case_comments, kaizen_notifications, kaizen_companies,
-- kaizen_super_admin_companies — each adds:
--   company_id IN (SELECT kaizen_user_company_ids())
-- (or kaizen_case_company(case_id) IN (...) for case sub-tables),
-- preserving the existing role/department logic.
