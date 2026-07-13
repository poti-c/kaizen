-- Fix: avatar re-upload fails with "new row violates row-level security policy".
--
-- SettingsPage.handleAvatarUpload uploads to a FIXED path (avatars/<userId>.jpg)
-- with { upsert: true }. The first upload is an INSERT (allowed by
-- kzn_storage_upload), but every subsequent upload overwrites the existing
-- object, which Supabase Storage performs as an UPDATE on storage.objects.
-- The kaizen-photos bucket had no UPDATE policy (only INSERT/SELECT/DELETE),
-- so the upsert was rejected by RLS.
--
-- Add an UPDATE policy mirroring the existing kaizen-invoices one
-- (kzn_invoices_update): any authenticated user may overwrite objects in the
-- kaizen-photos bucket.
CREATE POLICY "kzn_storage_update" ON storage.objects
  FOR UPDATE
  USING (bucket_id = 'kaizen-photos' AND auth.uid() IS NOT NULL)
  WITH CHECK (bucket_id = 'kaizen-photos' AND auth.uid() IS NOT NULL);
