-- Pre-launch tenant-isolation hardening (multi-tenant: DEMO + Na Nirand live).

-- 1) Block tenant-jumping: a non-super-admin must not change their own company_id
--    (the self-escalation guard previously covered role/department/is_active only).
CREATE OR REPLACE FUNCTION kaizen_profiles_prevent_self_escalation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.role IS DISTINCT FROM OLD.role)
     OR (NEW.department IS DISTINCT FROM OLD.department)
     OR (NEW.is_active IS DISTINCT FROM OLD.is_active)
     OR (NEW.company_id IS DISTINCT FROM OLD.company_id)
  THEN
    IF public.kaizen_current_role() <> 'super_admin' THEN
      RAISE EXCEPTION 'Only super admins can change role, department, company, or active status';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- 2) Scope company updates to companies the caller actually manages (was: any
--    super_admin could update ANY company row across all tenants).
DROP POLICY IF EXISTS "kzn_companies_update" ON kaizen_companies;
CREATE POLICY "kzn_companies_update" ON kaizen_companies
  FOR UPDATE
  USING (kaizen_current_role() = 'super_admin' AND id IN (SELECT kaizen_user_company_ids()))
  WITH CHECK (kaizen_current_role() = 'super_admin' AND id IN (SELECT kaizen_user_company_ids()));

-- 3) Billing/entitlement columns are Console/edge-function (service-role) only — no
--    client path writes them, so revoke direct client UPDATE as defense in depth.
REVOKE UPDATE (subscription_end, addons, plan, is_active, features,
               max_super_admins, max_managers, max_staff) ON kaizen_companies FROM authenticated, anon;
