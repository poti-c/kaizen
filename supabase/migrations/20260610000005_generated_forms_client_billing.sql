-- Snapshot the buyer's structured (bilingual) billing address on each generated
-- form so the printable document can be rendered in English or Thai on demand,
-- independent of later edits to the company record.
alter table public.kaizen_generated_forms
  add column if not exists client_billing jsonb;
