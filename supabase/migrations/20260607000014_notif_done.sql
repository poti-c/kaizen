-- Notifications inbox: a "done" state distinct from "read" (seen). Unread → seen
-- (read) on open → done when handled/dismissed.
ALTER TABLE kaizen_console_notifications ADD COLUMN IF NOT EXISTS done boolean NOT NULL DEFAULT false;
NOTIFY pgrst, 'reload schema';
