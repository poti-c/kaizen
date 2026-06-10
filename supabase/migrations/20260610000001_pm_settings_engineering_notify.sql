-- Engineering-department default PMS notifications + per-equipment exclusions.
-- notify_engineering: when true, all active Engineering Department users receive
--   due-soon / overdue / escalated PM notifications by default.
-- engineering_excluded_assets: asset ids carved out of that Engineering broadcast.
ALTER TABLE kaizen_pm_settings
  ADD COLUMN IF NOT EXISTS notify_engineering boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS engineering_excluded_assets uuid[] NOT NULL DEFAULT '{}';
