-- Rename a department everywhere it is stored, in ONE transaction.
--
-- Motivation (SettingsPage-2): Settings used to rename a department from the
-- browser in several separate PostgREST calls, and only migrated
-- kaizen_cases.department, kaizen_profiles.department and
-- kaizen_profiles.managed_departments. Everything else keyed on the department
-- value stayed on the old name — most visibly kaizen_cases.assigned_departments,
-- which the involved-department RLS branch (20260717000004) and every case
-- list filter match against, so staff of a renamed department lost sight of
-- every case their department was tagged on. A failure midway also left the
-- data half-migrated, papered over by a best-effort client-side rollback.
--
-- This function saves the new department list AND rewrites every
-- department-keyed column and settings blob of the company atomically:
--   kaizen_settings.custom_departments   (the new list, passed in)
--   kaizen_cases.department / assigned_departments
--   kaizen_case_assignments.department   (scoped via its case's company)
--   kaizen_profiles.department / managed_departments
--   kaizen_pm_assets.department / departments
--   kaizen_rr_templates.request_/fulfill_/deliver_department
--   kaizen_rr_orders.request_/fulfill_/deliver_department
--   kaizen_rr_room_lines.fulfill_/prepare_department
--   kaizen_settings rr_monitor_depts / rr_notify_recipients / rr_items /
--     rr_room_recipes (JSON blobs that store department values)
--
-- p_old / p_new are stored department VALUES (built-in slug, or a custom
-- department's label), not display labels — the caller maps label → value.
--
-- Idempotent (create or replace); safe to run against live.

create or replace function public.kaizen_rename_department(
  p_company_id  uuid,
  p_old         text,
  p_new         text,
  p_departments jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  -- SECURITY DEFINER bypasses RLS — this function MUST authorize its own caller.
  -- Only Top Management (super_admin) may rename departments ...
  if not exists (
    select 1 from public.kaizen_profiles kp
    where kp.id = auth.uid() and kp.role = 'super_admin'
  ) then
    raise exception 'not authorized';
  end if;

  -- ... and only for a company the caller is actually a member of.
  if p_company_id is null
     or p_company_id not in (select public.kaizen_user_company_ids()) then
    raise exception 'not authorized for company';
  end if;

  if coalesce(btrim(p_old), '') = '' or coalesce(btrim(p_new), '') = '' then
    raise exception 'department value must not be empty';
  end if;
  if p_departments is null or jsonb_typeof(p_departments) <> 'array' then
    raise exception 'p_departments must be a JSON array';
  end if;

  -- The list itself (same upsert Settings' saveList does).
  insert into public.kaizen_settings (key, value, company_id, updated_by, updated_at)
  values ('custom_departments', p_departments, p_company_id, auth.uid(), now())
  on conflict (key, company_id)
  do update set value = excluded.value, updated_by = excluded.updated_by, updated_at = now();

  -- A label-only change (e.g. a built-in whose slug is unchanged) moves no data.
  if p_old = p_new then
    return;
  end if;

  -- Arrays: replace old with new, dropping old instead when new is already there
  -- so a row never lists the same department twice.

  -- ── cases ────────────────────────────────────────────────────────────────
  update public.kaizen_cases set department = p_new
   where company_id = p_company_id and department = p_old;

  update public.kaizen_cases
     set assigned_departments = case when p_new = any(assigned_departments)
                                     then array_remove(assigned_departments, p_old)
                                     else array_replace(assigned_departments, p_old, p_new) end
   where company_id = p_company_id and p_old = any(assigned_departments);

  -- UNIQUE (case_id, department): a case that somehow already has a row for the
  -- new value keeps both rather than failing the whole rename.
  update public.kaizen_case_assignments a set department = p_new
    from public.kaizen_cases c
   where c.id = a.case_id and c.company_id = p_company_id
     and a.department = p_old
     and not exists (
       select 1 from public.kaizen_case_assignments x
        where x.case_id = a.case_id and x.department = p_new
     );

  -- ── profiles ─────────────────────────────────────────────────────────────
  -- kaizen_profiles_prevent_self_escalation allows this: the caller is super_admin.
  update public.kaizen_profiles set department = p_new
   where company_id = p_company_id and department = p_old;

  update public.kaizen_profiles
     set managed_departments = case when p_new = any(managed_departments)
                                    then array_remove(managed_departments, p_old)
                                    else array_replace(managed_departments, p_old, p_new) end
   where company_id = p_company_id and p_old = any(managed_departments);

  -- ── preventive maintenance ───────────────────────────────────────────────
  update public.kaizen_pm_assets set department = p_new
   where company_id = p_company_id and department = p_old;

  update public.kaizen_pm_assets
     set departments = case when p_new = any(departments)
                            then array_remove(departments, p_old)
                            else array_replace(departments, p_old, p_new) end
   where company_id = p_company_id and p_old = any(departments);

  -- ── routine roster ───────────────────────────────────────────────────────
  update public.kaizen_rr_templates
     set request_department = case when request_department = p_old then p_new else request_department end,
         fulfill_department = case when fulfill_department = p_old then p_new else fulfill_department end,
         deliver_department = case when deliver_department = p_old then p_new else deliver_department end
   where company_id = p_company_id
     and p_old in (request_department, fulfill_department, deliver_department);

  -- kaizen_rr_orders_enforce_stage_dept lets super_admin through unconditionally.
  update public.kaizen_rr_orders
     set request_department = case when request_department = p_old then p_new else request_department end,
         fulfill_department = case when fulfill_department = p_old then p_new else fulfill_department end,
         deliver_department = case when deliver_department = p_old then p_new else deliver_department end
   where company_id = p_company_id
     and p_old in (request_department, fulfill_department, deliver_department);

  update public.kaizen_rr_room_lines
     set fulfill_department = case when fulfill_department = p_old then p_new else fulfill_department end,
         prepare_department = case when prepare_department = p_old then p_new else prepare_department end
   where company_id = p_company_id
     and p_old in (fulfill_department, prepare_department);

  -- ── settings blobs that store department values ─────────────────────────
  -- rr_monitor_depts: ["front_office", ...] — replace, de-duplicate, keep order.
  update public.kaizen_settings s
     set value = (
           select coalesce(jsonb_agg(x order by ord), '[]'::jsonb)
             from (
               select case when e = to_jsonb(p_old) then to_jsonb(p_new) else e end as x,
                      min(ord) as ord
                 from jsonb_array_elements(s.value) with ordinality t(e, ord)
                group by 1
             ) d
         ),
         updated_at = now()
   where s.company_id = p_company_id and s.key = 'rr_monitor_depts'
     and jsonb_typeof(s.value) = 'array' and s.value @> jsonb_build_array(p_old);

  -- rr_notify_recipients: { "<dept>": { mode, ids } } — move the old key.
  update public.kaizen_settings s
     set value = (s.value - p_old) || jsonb_build_object(p_new, s.value -> p_old),
         updated_at = now()
   where s.company_id = p_company_id and s.key = 'rr_notify_recipients'
     and jsonb_typeof(s.value) = 'object' and s.value ? p_old and not s.value ? p_new;

  -- rr_items: [{ department, deliver_department, ... }]
  update public.kaizen_settings s
     set value = (
           select coalesce(jsonb_agg(
                    case when jsonb_typeof(e) = 'object' then
                      e
                      || case when e ->> 'department' = p_old
                              then jsonb_build_object('department', p_new) else '{}'::jsonb end
                      || case when e ->> 'deliver_department' = p_old
                              then jsonb_build_object('deliver_department', p_new) else '{}'::jsonb end
                    else e end
                    order by ord), '[]'::jsonb)
             from jsonb_array_elements(s.value) with ordinality t(e, ord)
         ),
         updated_at = now()
   where s.company_id = p_company_id and s.key = 'rr_items'
     and jsonb_typeof(s.value) = 'array';

  -- rr_room_recipes: { "<category id>": [{ fulfill_department, prepare_department, ... }] }
  update public.kaizen_settings s
     set value = (
           select jsonb_object_agg(k,
                    case when jsonb_typeof(v) = 'array' then (
                      select coalesce(jsonb_agg(
                               case when jsonb_typeof(e) = 'object' then
                                 e
                                 || case when e ->> 'fulfill_department' = p_old
                                         then jsonb_build_object('fulfill_department', p_new) else '{}'::jsonb end
                                 || case when e ->> 'prepare_department' = p_old
                                         then jsonb_build_object('prepare_department', p_new) else '{}'::jsonb end
                               else e end
                               order by ord), '[]'::jsonb)
                        from jsonb_array_elements(v) with ordinality t(e, ord)
                    ) else v end)
             from jsonb_each(s.value) j(k, v)
         ),
         updated_at = now()
   where s.company_id = p_company_id and s.key = 'rr_room_recipes'
     and jsonb_typeof(s.value) = 'object' and s.value <> '{}'::jsonb;
end;
$$;

-- Grants: the browser (an authenticated super_admin) calls this. Name the roles —
-- REVOKE ... FROM PUBLIC alone leaves Supabase's explicit anon grant intact.
revoke all on function public.kaizen_rename_department(uuid, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.kaizen_rename_department(uuid, text, text, jsonb) to authenticated;
