-- Issuer contact details shown on generated documents.
ALTER TABLE kaizen_console_settings ADD COLUMN IF NOT EXISTS phone   text;
ALTER TABLE kaizen_console_settings ADD COLUMN IF NOT EXISTS email   text;
ALTER TABLE kaizen_console_settings ADD COLUMN IF NOT EXISTS website text;
