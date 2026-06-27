-- Replacing a document re-uploads to the same path with upsert, which Storage performs as an
-- UPDATE on storage.objects. Without an UPDATE policy that fails with
-- "new row violates row-level security policy". Add the missing policy for the invoices bucket.
drop policy if exists "kzn_invoices_update" on storage.objects;
create policy "kzn_invoices_update" on storage.objects for update
  using (bucket_id = 'kaizen-invoices' and auth.uid() is not null)
  with check (bucket_id = 'kaizen-invoices' and auth.uid() is not null);
