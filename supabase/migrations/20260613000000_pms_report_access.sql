-- PMS report access control: which managers may open the Preventive Maintenance report.
-- Top Management (super_admin) always has access implicitly; this list grants additional managers.
ALTER TABLE kaizen_pm_settings ADD COLUMN IF NOT EXISTS report_manager_ids uuid[] DEFAULT '{}';
