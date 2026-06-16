-- Drop columns made obsolete by the click-to-order Routine Roster redesign.
--   run_weekdays  — per-weekday scheduling; routines are now orderable any day
--   order_open    — evening ordering window; no longer enforced (manual ordering)
--   order_close   — evening ordering window; no longer enforced (manual ordering)
--   remind_at     — reminder time; no reminder job ever read it (dead config)
-- These were all written as NULL after the redesign; this removes them for good.

ALTER TABLE kaizen_rr_templates
  DROP COLUMN IF EXISTS run_weekdays,
  DROP COLUMN IF EXISTS order_open,
  DROP COLUMN IF EXISTS order_close,
  DROP COLUMN IF EXISTS remind_at;
