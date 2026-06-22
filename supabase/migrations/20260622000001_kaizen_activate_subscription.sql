-- Atomic subscription activation/renewal for kaizen-pay.
-- Replaces the read-modify-write on subscription_end so two concurrent verified
-- subscription payments for the same company stack instead of clobbering each other
-- (the loser previously overwrote the winner, losing one paid term's worth of days).
-- Mirrors the atomic approach already used for add-ons (kaizen_merge_company_addon).
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
RETURNS TABLE(from_plan text, new_end date)
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
  RETURN NEXT;
END;
$$;
