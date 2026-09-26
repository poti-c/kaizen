-- Shared-device push leak. A push subscription belongs to a browser, not a
-- person, and signing out never removed its kaizen_push_subscriptions row. When
-- a second person signed in on the same device, auto-subscribe added a row for
-- them with the SAME endpoint (unique key is (user_id, endpoint)), so the device
-- kept receiving the previous user's notifications — and the service worker
-- re-badged the icon with their unread count. On 2026-09-26, 3 endpoints were
-- shared by 14 rows.
--
-- The app now deletes its own row on sign-out, but that can't cover a session
-- that simply expired, a suspension sign-out, or rows left before this fix: RLS
-- only lets a user touch rows where user_id = auth.uid(). This function lets the
-- signed-in user claim the device's endpoint, deleting every OTHER user's row for
-- it. usePushNotifications.subscribe() calls it on each app open.
--
-- Authorization: the caller must be signed in, and must present the endpoint.
-- A push endpoint is an unguessable capability URL known only to the browser
-- that holds the subscription, so presenting it proves the caller is on that
-- device. It returns only a count, never other users' data.
--
-- Idempotent (create or replace); safe to run against live.

CREATE OR REPLACE FUNCTION public.kaizen_claim_push_endpoint(p_endpoint text)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_removed integer;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;
  IF p_endpoint IS NULL OR btrim(p_endpoint) = '' THEN
    RETURN 0;
  END IF;

  DELETE FROM public.kaizen_push_subscriptions
   WHERE endpoint = p_endpoint
     AND user_id <> auth.uid();
  GET DIAGNOSTICS v_removed = ROW_COUNT;
  RETURN v_removed;
END;
$$;

-- Browser-called: authenticated only. Name the roles (CLAUDE.md) — REVOKE ...
-- FROM PUBLIC alone leaves Supabase's explicit anon grant in place.
REVOKE ALL ON FUNCTION public.kaizen_claim_push_endpoint(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.kaizen_claim_push_endpoint(text) TO authenticated;

NOTIFY pgrst, 'reload schema';
