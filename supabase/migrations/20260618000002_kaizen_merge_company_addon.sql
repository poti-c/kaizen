-- Atomic JSONB merge for company add-ons.
-- Replaces the read-modify-write in kaizen-pay so concurrent payments for different
-- add-ons cannot clobber each other.
CREATE OR REPLACE FUNCTION kaizen_merge_company_addon(p_company_id uuid, p_addon_key text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  UPDATE kaizen_companies
  SET addons = COALESCE(addons, '{}'::jsonb) || jsonb_build_object(p_addon_key, true)
  WHERE id = p_company_id;
END;
$$;
