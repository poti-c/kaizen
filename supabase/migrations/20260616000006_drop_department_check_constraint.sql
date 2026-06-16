-- Allow custom company departments (e.g. "Spa") beyond the hardcoded built-in list.
-- Application-level validation in the UI replaces this DB-level enum check.
ALTER TABLE kaizen_profiles DROP CONSTRAINT kaizen_profiles_department_check;
