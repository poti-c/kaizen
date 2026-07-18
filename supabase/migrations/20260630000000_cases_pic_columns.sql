-- Backfill the migration for kaizen_cases.person_in_charge / pic_ids.
--
-- Both columns were added directly to the live project and never captured
-- here, yet later migrations reference them inside CREATE POLICY bodies:
--   20260701000000_kaizen_cases_creator_update.sql   (auth.uid() = person_in_charge)
--   20260717000004_cases_involved_dept_visibility.sql
-- Postgres resolves column references when a policy is created, so a rebuild
-- from migrations aborted at 20260701000000 and every later migration never
-- ran. This file is deliberately timestamped BEFORE that policy migration so
-- the columns exist by the time the policies reference them.
--
--   person_in_charge — single assignee (legacy, still read by the RLS policies)
--   pic_ids          — multi-assignee list that superseded it
--
-- Matches the live definitions; `if not exists` makes this a no-op against the
-- live project.

ALTER TABLE kaizen_cases
  ADD COLUMN IF NOT EXISTS person_in_charge uuid,
  ADD COLUMN IF NOT EXISTS pic_ids uuid[] DEFAULT '{}'::uuid[];

NOTIFY pgrst, 'reload schema';
