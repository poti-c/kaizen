-- Allow a manager to be responsible for more than one department.
-- managed_departments stores extra departments beyond the primary one.
ALTER TABLE kaizen_profiles
  ADD COLUMN IF NOT EXISTS managed_departments TEXT[] NOT NULL DEFAULT '{}';
