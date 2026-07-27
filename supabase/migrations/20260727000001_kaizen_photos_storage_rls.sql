-- StoragePolicies-1 / OrphanSweep-2: storage.objects INSERT/UPDATE/DELETE for the
-- kaizen-photos bucket only ever checked `auth.uid() IS NOT NULL` — no ownership or
-- company scoping at all. Table-level RLS on kaizen_case_photos etc. was already scoped
-- by company_id (20260604000002_tenant_isolation_rls.sql), but that fix was never
-- mirrored onto the Storage layer: any authenticated user, from ANY company, could call
-- the Storage REST API directly to overwrite or delete another company's case-evidence
-- photos or another user's avatar, since object paths are fully visible in every public
-- photo_url served to any client.
--
-- Scope by path shape:
--   - avatars/<uid>.<ext>            -> <uid> must equal auth.uid() (or caller is super_admin)
--   - <company_id>/kaizen/<yyyy-mm>/... -> <company_id> must be in kaizen_user_company_ids()
--   - anything else (the legacy/unsorted fallback paths used when a company/case isn't
--     known yet — see na_nirand_kaizen/... in buildPhotoPath and PhotoUpload.tsx) keeps
--     TODAY'S existing auth.uid() IS NOT NULL check. Tightening those too would need the
--     client to always know its company/case before uploading, which it doesn't yet in
--     every code path (e.g. before activeCompany loads) — grandfathering them avoids
--     turning this security fix into an outage for a legitimate mobile upload.
CREATE OR REPLACE FUNCTION kaizen_storage_photo_owned(name text)
RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  seg1 text := (storage.foldername(name))[1];
  seg2 text := (storage.foldername(name))[2];
  parts text[] := string_to_array(name, '/');
  fname text := parts[array_length(parts, 1)];
BEGIN
  IF auth.uid() IS NULL THEN RETURN false; END IF;

  IF seg1 = 'avatars' THEN
    RETURN split_part(fname, '.', 1) = auth.uid()::text OR kaizen_current_role() = 'super_admin';
  END IF;

  IF seg2 = 'kaizen' AND seg1 ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN
    RETURN seg1::uuid IN (SELECT kaizen_user_company_ids());
  END IF;

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION kaizen_storage_photo_owned(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION kaizen_storage_photo_owned(text) TO authenticated, service_role;

DROP POLICY IF EXISTS "kzn_storage_upload" ON storage.objects;
DROP POLICY IF EXISTS "kzn_storage_update" ON storage.objects;
DROP POLICY IF EXISTS "kzn_storage_delete" ON storage.objects;

CREATE POLICY "kzn_storage_upload" ON storage.objects
  FOR INSERT WITH CHECK (bucket_id = 'kaizen-photos' AND kaizen_storage_photo_owned(name));
CREATE POLICY "kzn_storage_update" ON storage.objects
  FOR UPDATE
  USING (bucket_id = 'kaizen-photos' AND kaizen_storage_photo_owned(name))
  WITH CHECK (bucket_id = 'kaizen-photos' AND kaizen_storage_photo_owned(name));
CREATE POLICY "kzn_storage_delete" ON storage.objects
  FOR DELETE USING (bucket_id = 'kaizen-photos' AND kaizen_storage_photo_owned(name));

NOTIFY pgrst, 'reload schema';
