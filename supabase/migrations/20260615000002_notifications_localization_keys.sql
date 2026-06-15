-- Structured localization for notifications: store a stable title_key + params so the
-- feed/bell can render in the READER's language. title/message remain as an English
-- fallback (older clients, push payloads).
ALTER TABLE kaizen_notifications ADD COLUMN IF NOT EXISTS title_key text;
ALTER TABLE kaizen_notifications ADD COLUMN IF NOT EXISTS body_params jsonb;
