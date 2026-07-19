-- CDP-BUG-01 residual gap (see 4b31431 commit message): CaseDetailPage's
-- canEditPic was narrowed in the UI to super_admin / the acting department
-- manager / staff who are already In Charge or the case's creator — but the
-- kzn_cases_update RLS policy (20260717000004_cases_involved_dept_visibility.sql)
-- still lets ANY staff member in the case's department write pic_ids/
-- person_in_charge via a raw PATCH, since it has no WITH CHECK and its
-- department branch is unconditional. This mirrors the SAME class of gap the
-- commit message already flagged for the status field, just on a separate
-- condition it didn't call out.
--
-- Following this codebase's existing convention for column-level lockdown
-- (kaizen_profiles_prevent_self_escalation, 20260604000001): keep RLS broad,
-- enforce fine-grained "who may change this column" via a BEFORE UPDATE
-- trigger that compares OLD/NEW. Scoped ONLY to pic_ids/person_in_charge —
-- there is exactly one write path for these columns in the app (savePic() in
-- CaseDetailPage.tsx), so this is safe to lock down precisely, unlike status
-- (many legitimate call sites, deliberately left for a future, more careful
-- change).
CREATE OR REPLACE FUNCTION kaizen_cases_prevent_pic_bypass()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.pic_ids IS DISTINCT FROM OLD.pic_ids)
     OR (NEW.person_in_charge IS DISTINCT FROM OLD.person_in_charge) THEN
    IF NOT (
      kaizen_current_role() = 'super_admin'
      OR (
        kaizen_current_role() = 'manager'
        AND (kaizen_current_dept() = 'human_resource' OR kaizen_current_dept() = OLD.department)
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

DROP TRIGGER IF EXISTS kaizen_cases_prevent_pic_bypass ON kaizen_cases;
CREATE TRIGGER kaizen_cases_prevent_pic_bypass
  BEFORE UPDATE ON kaizen_cases
  FOR EACH ROW EXECUTE FUNCTION kaizen_cases_prevent_pic_bypass();
