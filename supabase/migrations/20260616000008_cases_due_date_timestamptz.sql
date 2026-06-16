-- Allow case due dates to carry a time, not just a calendar day, so urgent cases
-- can be due within minutes/hours (e.g. "due in 30 minutes" / "by 14:00 today").
--
-- Existing date-only values meant "due by the end of that day", so convert them to
-- 23:59:59 Asia/Bangkok (the hotel's local time) to preserve that meaning.
ALTER TABLE kaizen_cases
  ALTER COLUMN due_date TYPE timestamptz
  USING (due_date + time '23:59:59') AT TIME ZONE 'Asia/Bangkok';
