-- Console "Auto-Fix" toggle (safe auto-remediation of known recurring issues).
ALTER TABLE kaizen_console_settings ADD COLUMN IF NOT EXISTS auto_fix boolean NOT NULL DEFAULT false;
NOTIFY pgrst, 'reload schema';
