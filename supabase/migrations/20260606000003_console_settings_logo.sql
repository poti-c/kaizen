-- Company logo for the invoice issuer (stored as a small PNG data URL).
ALTER TABLE kaizen_console_settings ADD COLUMN IF NOT EXISTS logo_url text;
