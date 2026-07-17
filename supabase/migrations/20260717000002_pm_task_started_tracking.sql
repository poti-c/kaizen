-- Track who started (accepted) a PM task and when, so the task modal can show a
-- full audit timeline: Scheduled → Started → Completed → Approved.
ALTER TABLE kaizen_pm_tasks ADD COLUMN IF NOT EXISTS started_at timestamptz;
ALTER TABLE kaizen_pm_tasks ADD COLUMN IF NOT EXISTS started_by uuid REFERENCES kaizen_profiles(id) ON DELETE SET NULL;

NOTIFY pgrst, 'reload schema';
