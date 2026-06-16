-- Custom departments (e.g. "Spa") are stored by their label, but this CHECK only
-- allowed the built-in slugs — so staff in a custom department could not create a
-- case (the insert violated the constraint). Drop it, mirroring the same fix
-- already applied to kaizen_profiles. Department values are validated in the app.
ALTER TABLE kaizen_cases
  DROP CONSTRAINT IF EXISTS kaizen_cases_department_check;
