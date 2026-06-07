-- Ensure every auto-created PM case (case_number 'PM-…') uses the Preventive
-- Maintenance category. New cases already get this from kaizen_pm_sync; this
-- backfills any earlier ones created with the legacy 'maintenance' category.
UPDATE kaizen_cases
   SET category = 'preventive_maintenance', updated_at = now()
 WHERE case_number LIKE 'PM-%' AND COALESCE(category, '') <> 'preventive_maintenance';
