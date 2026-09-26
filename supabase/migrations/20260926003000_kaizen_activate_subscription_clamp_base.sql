-- KaizenPay-1: kaizen_activate_subscription extended from COALESCE(subscription_end,
-- today), which only fell back to today when subscription_end was NULL. A company
-- whose plan had LAPSED renewed from its old, past expiry: 200 days expired + a
-- 365-day payment gave only 165 days, and a lapse longer than a term stayed expired
-- even though the payment was auto-approved. The invoice period_start (old_end) was
-- stamped with the stale past date too. The Console's manual approve_payment already
-- clamps with max(subscription_end, today); match it here.
--
-- Identical to 20260727000000 except the base is clamped to today (Asia/Bangkok),
-- and that clamped base is what is returned as old_end. Same signature and return
-- type, so CREATE OR REPLACE is safe and a no-op if re-run.
CREATE OR REPLACE FUNCTION kaizen_activate_subscription(
  p_company_id uuid,
  p_plan text,
  p_term_days int,
  p_max_super_admins int,
  p_max_managers int,
  p_max_staff int,
  p_multi_company boolean,
  p_features jsonb
)
RETURNS TABLE(from_plan text, new_end date, old_end date)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_from text;
  v_base date;
  v_today date := (now() AT TIME ZONE 'Asia/Bangkok')::date;
BEGIN
  -- Lock the company row so concurrent renewals serialize and each extends from the
  -- previous one's committed expiry instead of all reading the same base date.
  SELECT plan, subscription_end INTO v_from, v_base
  FROM kaizen_companies
  WHERE id = p_company_id
  FOR UPDATE;

  -- Extend from the existing expiry when it is still in the future (early renewers
  -- keep remaining days); a first-ever OR lapsed subscription anchors to TODAY in
  -- Asia/Bangkok so the customer gets the full term they paid for.
  v_base := GREATEST(COALESCE(v_base, v_today), v_today);

  UPDATE kaizen_companies
  SET plan = p_plan,
      subscription_end = (v_base + (p_term_days || ' days')::interval)::date,
      max_super_admins = p_max_super_admins,
      max_managers = p_max_managers,
      max_staff = p_max_staff,
      multi_company = p_multi_company,
      features = p_features
  WHERE id = p_company_id
  RETURNING kaizen_companies.subscription_end INTO new_end;

  from_plan := v_from;
  old_end := v_base;
  RETURN NEXT;
END;
$$;

-- SECURITY DEFINER with no caller check of its own: service_role (kaizen-pay) only.
-- Name the roles — REVOKE ... FROM PUBLIC alone leaves Supabase's explicit anon grant.
REVOKE ALL ON FUNCTION public.kaizen_activate_subscription(uuid, text, integer, integer, integer, integer, boolean, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.kaizen_activate_subscription(uuid, text, integer, integer, integer, integer, boolean, jsonb)
  TO service_role;
