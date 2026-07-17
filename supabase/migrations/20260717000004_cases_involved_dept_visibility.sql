-- Case visibility for INVOLVED departments.
--
-- Bug: when a case is assigned/handled, the opener or a manager can "tag" other
-- departments (they land in kaizen_cases.assigned_departments = "Departments
-- Involved") and every member of those departments gets a notification. But the
-- RLS SELECT policy only let a staff user see a case whose PRIMARY `department`
-- matched theirs (or where they were a named PIC). So a tagged department's staff
-- (e.g. Engineering, tagged onto a Kitchen case) got the ping but the case never
-- appeared for them — "ทางช่างจะไม่เห็น".
--
-- Fix: staff may also SELECT / UPDATE a case when THEIR department is one of the
-- case's assigned (involved) departments. Managers and named PICs already have
-- cross-department access; this closes the same gap for involved-department staff.

DROP POLICY IF EXISTS "kzn_cases_select" ON kaizen_cases;
CREATE POLICY "kzn_cases_select" ON kaizen_cases FOR SELECT USING (
  kaizen_current_role() IN ('super_admin','manager')
  OR (kaizen_current_role() = 'staff' AND department = kaizen_current_dept())
  OR (kaizen_current_role() = 'staff' AND kaizen_current_dept() = ANY(COALESCE(assigned_departments, '{}'::text[])))
  OR auth.uid() = ANY(COALESCE(pic_ids, '{}'::uuid[]))
  OR auth.uid() = person_in_charge
);

-- NOTE: preserve the `created_by` carve-out added in 20260701000000 (a case opener
-- may edit their own case after it is reassigned) — this policy must keep every
-- prior branch and only ADD the involved-department branch.
DROP POLICY IF EXISTS "kzn_cases_update" ON kaizen_cases;
CREATE POLICY "kzn_cases_update" ON kaizen_cases FOR UPDATE USING (
  kaizen_current_role() IN ('super_admin','manager')
  OR (kaizen_current_role() = 'staff' AND department = kaizen_current_dept())
  OR (kaizen_current_role() = 'staff' AND kaizen_current_dept() = ANY(COALESCE(assigned_departments, '{}'::text[])))
  OR auth.uid() = ANY(COALESCE(pic_ids, '{}'::uuid[]))
  OR auth.uid() = person_in_charge
  OR auth.uid() = created_by
);
