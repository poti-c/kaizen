-- Authorised signatory shown on generated documents (issuer side).
ALTER TABLE kaizen_console_settings ADD COLUMN IF NOT EXISTS signatory_name  text;
ALTER TABLE kaizen_console_settings ADD COLUMN IF NOT EXISTS signatory_title text;

-- Sensible defaults for the NNR-Solutions issuer row.
UPDATE kaizen_console_settings
   SET signatory_name  = COALESCE(signatory_name,  'Dr. Poti Chaopaisarn'),
       signatory_title = COALESCE(signatory_title, 'Managing Director')
 WHERE id = true;
