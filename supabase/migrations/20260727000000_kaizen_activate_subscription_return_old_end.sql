-- KaizenPay-1: kaizen-pay used to read subscription_end via a separate, UNLOCKED
-- SELECT before calling this row-locked RPC, to compute the invoice's period_start.
-- Two verified renewal payments for the same company landing close together could
-- both read the same pre-renewal subscription_end that way — the RPC itself still
-- correctly serializes and stacks the actual subscription_end extension, but the
-- second payment's invoice period_start ended up wrong (the old, pre-first-payment
-- expiry instead of the first payment's new_end).
--
-- Return the pre-update subscription_end (captured under the same FOR UPDATE lock,
-- after the same COALESCE-to-today fallback the edge function already replicated)
-- so the caller no longer needs its own separate, unlocked read.
DROP FUNCTION IF EXISTS kaizen_activate_subscription(uuid, text, int, int, int, int, boolean, jsonb);

CREATE FUNCTION kaizen_activate_subscription(
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
BEGIN
  -- Lock the company row so concurrent renewals serialize and each extends from the
  -- previous one's committed expiry instead of all reading the same base date.
  SELECT plan, subscription_end INTO v_from, v_base
  FROM kaizen_companies
  WHERE id = p_company_id
  FOR UPDATE;

  -- Extend from the existing expiry (early renewers keep remaining days); a first-ever
  -- subscription anchors to TODAY in Asia/Bangkok so the term length doesn't drift by the
  -- payment hour. Matches the previous JS logic, now computed atomically in-DB.
  v_base := COALESCE(v_base, (now() AT TIME ZONE 'Asia/Bangkok')::date);

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

REVOKE ALL ON FUNCTION kaizen_activate_subscription(uuid, text, int, int, int, int, boolean, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION kaizen_activate_subscription(uuid, text, int, int, int, int, boolean, jsonb) TO service_role;
