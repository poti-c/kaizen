-- CaseDetailPage-005 follow-up: the client now treats a manager whose
-- kaizen_profiles.managed_departments covers a case's department as that
-- department's manager (getEffectiveDepts), so it opens the PIC editor for them.
-- kaizen_cases_prevent_pic_bypass (20260720000000) still only accepted a
-- manager whose OWN department matched, so every PIC save by a covering manager
-- was rejected with "Not authorized to change pic_ids/person_in_charge".
--
-- Same rule as getEffectiveDepts: a manager manages their own department plus
-- every entry in managed_departments.
--
-- Idempotent (create or replace); safe to run against live.

-- Mirrors kaizen_current_dept(): SECURITY DEFINER so the trigger can read the
-- caller's own profile regardless of kaizen_profiles RLS.
CREATE OR REPLACE FUNCTION public.kaizen_current_managed_depts()
RETURNS text[] LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(managed_departments, '{}'::text[]) FROM public.kaizen_profiles WHERE id = auth.uid()
$$;

-- Only reveals the caller's own row, but still name the roles (see CLAUDE.md):
-- the trigger runs as the writing role, which is authenticated or service_role.
REVOKE ALL ON FUNCTION public.kaizen_current_managed_depts() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.kaizen_current_managed_depts() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION kaizen_cases_prevent_pic_bypass()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.pic_ids IS DISTINCT FROM OLD.pic_ids)
     OR (NEW.person_in_charge IS DISTINCT FROM OLD.person_in_charge) THEN
    IF NOT (
      kaizen_current_role() = 'super_admin'
      OR (
        kaizen_current_role() = 'manager'
        AND (
          kaizen_current_dept() = 'human_resource'
          OR kaizen_current_dept() = OLD.department
          OR OLD.department = ANY(COALESCE(kaizen_current_managed_depts(), '{}'::text[]))
        )
      )
      OR auth.uid() = OLD.created_by
      OR auth.uid() = ANY(COALESCE(OLD.pic_ids, '{}'::uuid[]))
      OR auth.uid() = OLD.person_in_charge
    ) THEN
      RAISE EXCEPTION 'Not authorized to change pic_ids/person_in_charge on this case';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- Trigger functions are never called directly; name the roles anyway so the
-- default anon/authenticated EXECUTE grants don't linger (CLAUDE.md).
REVOKE ALL ON FUNCTION public.kaizen_cases_prevent_pic_bypass() FROM PUBLIC, anon, authenticated;
