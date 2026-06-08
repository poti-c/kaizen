ALTER TABLE kaizen_pm_assets ADD COLUMN IF NOT EXISTS purchase_date date;
NOTIFY pgrst, 'reload schema';
