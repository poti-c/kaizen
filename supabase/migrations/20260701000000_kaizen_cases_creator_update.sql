-- The case creator (opener) may edit their own case, even after the case's
-- department is reassigned away from their own — mirrors the existing
-- pic_ids/person_in_charge carve-outs so the RLS policy matches the UI gate
-- (canEditCase) in CaseDetailPage.tsx.
drop policy if exists kzn_cases_update on kaizen_cases;
create policy kzn_cases_update on kaizen_cases
  for update
  using (
    kaizen_current_role() = any (array['super_admin', 'manager'])
    or (kaizen_current_role() = 'staff' and department = kaizen_current_dept())
    or auth.uid() = any (coalesce(pic_ids, '{}'::uuid[]))
    or auth.uid() = person_in_charge
    or auth.uid() = created_by
  );
