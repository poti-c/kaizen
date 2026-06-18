-- Enforce unique document numbers per form type so the create_form numbering
-- race (concurrent read-max-then-insert) surfaces as a 23505 and is retried by
-- the edge function instead of silently issuing duplicate invoice/receipt numbers.
CREATE UNIQUE INDEX IF NOT EXISTS kaizen_generated_forms_type_docnum_uidx
  ON kaizen_generated_forms (form_type, doc_number);
