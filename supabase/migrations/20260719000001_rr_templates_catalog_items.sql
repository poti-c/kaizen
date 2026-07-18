-- Backfill the migration for kaizen_rr_templates.catalog_items.
-- The column was added directly to the live project and never captured here, so
-- a rebuild from migrations produced a table without it and every routine
-- template save failed with PGRST204 ("column not found in schema cache").
--
-- Shape: [{ "label": "Bath towel", "unit": "pc" }, ...] — the subset of the
-- department item catalogue this routine orders from. NULL = not configured.
-- Matches the live definition (jsonb, nullable, no default); `if not exists`
-- makes this a no-op against the live project.

ALTER TABLE kaizen_rr_templates
  ADD COLUMN IF NOT EXISTS catalog_items jsonb;

NOTIFY pgrst, 'reload schema';
