-- Accounting → Front Office document handoff: Accounting uploads the receipt / tax invoice
-- (PDF or image) which Front Office can then view, print, and confirm received.

-- Per-line document pointer (path in the private kaizen-invoices bucket + original filename).
alter table kaizen_rr_room_lines
  add column if not exists document_path text,
  add column if not exists document_name text;

-- The invoices bucket holds sensitive financial docs — keep it private, allow PDF + images,
-- cap at 2 MB (images are downscaled client-side; digital PDFs are well under this).
update storage.buckets
  set allowed_mime_types = array['application/pdf','image/jpeg','image/png','image/webp'],
      file_size_limit = 2097152,
      public = false
  where id = 'kaizen-invoices';

-- Access policies for the invoices bucket: any authenticated user in the app may upload,
-- read (needed to mint signed URLs), and replace/delete. Tenant scoping is enforced by the
-- app + the room-lines RLS; objects are only reachable via short-lived signed URLs.
drop policy if exists "kzn_invoices_insert" on storage.objects;
create policy "kzn_invoices_insert" on storage.objects for insert
  with check (bucket_id = 'kaizen-invoices' and auth.uid() is not null);
drop policy if exists "kzn_invoices_read" on storage.objects;
create policy "kzn_invoices_read" on storage.objects for select
  using (bucket_id = 'kaizen-invoices' and auth.uid() is not null);
drop policy if exists "kzn_invoices_delete" on storage.objects;
create policy "kzn_invoices_delete" on storage.objects for delete
  using (bucket_id = 'kaizen-invoices' and auth.uid() is not null);
