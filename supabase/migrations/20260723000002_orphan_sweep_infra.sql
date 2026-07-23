-- Scheduled orphan-photo sweep: supporting DB objects.
--
-- The kaizen-photos bucket accumulates orphans — objects uploaded but never
-- attached to a case (mostly the resolve form losing photos on reload; see the
-- 2026-07 fix). This defines the authoritative orphan query, a run log, and the
-- shared secret that gates the sweep edge function. The edge function
-- (supabase/functions/kaizen-orphan-sweep) and the cron schedule
-- (20260723000003_orphan_sweep_cron.sql) drive it.
--
-- Idempotent; safe to run against live.

-- Run history (readable by Top Management).
create table if not exists public.kaizen_maintenance_log (
  id            uuid primary key default gen_random_uuid(),
  job           text not null,
  ran_at        timestamptz not null default now(),
  deleted_count int not null default 0,
  details       jsonb
);
alter table public.kaizen_maintenance_log enable row level security;
drop policy if exists kzn_maint_log_read on public.kaizen_maintenance_log;
create policy kzn_maint_log_read on public.kaizen_maintenance_log for select
  using (exists (select 1 from public.kaizen_profiles p where p.id = auth.uid() and p.role = 'super_admin'));

-- Locked config (RLS on, no policies) → only service_role / postgres (which
-- bypass RLS) can read. Holds the shared secret that gates the sweep function.
-- gen_random_uuid() gives each environment its own secret on a fresh rebuild.
create table if not exists public.kaizen_maintenance_config (
  key   text primary key,
  value text not null
);
alter table public.kaizen_maintenance_config enable row level security;
insert into public.kaizen_maintenance_config (key, value)
  values ('orphan_sweep_secret', gen_random_uuid()::text)
  on conflict (key) do nothing;

-- Authoritative orphan definition: objects in kaizen-photos older than the given
-- age that no live row references — case photos, avatars, company/console logos,
-- payment proofs, PM-task photos — with the ?t= cache-buster stripped so a
-- referenced avatar is never mistaken for an orphan (a trap that nearly deleted
-- live avatars during the manual 2026-07 cleanup).
create or replace function public.kaizen_list_orphan_photos(p_older_than interval default '7 days')
returns setof text
language sql
security definer
stable
set search_path = public, storage
as $$
  with referenced as (
    select split_part(split_part(photo_url,'/kaizen-photos/',2),'?',1) as name from kaizen_case_photos where photo_url like '%/kaizen-photos/%'
    union select split_part(split_part(avatar_url,'/kaizen-photos/',2),'?',1) from kaizen_profiles where avatar_url like '%/kaizen-photos/%'
    union select split_part(split_part(logo_url,'/kaizen-photos/',2),'?',1) from kaizen_companies where logo_url like '%/kaizen-photos/%'
    union select split_part(split_part(logo_url,'/kaizen-photos/',2),'?',1) from kaizen_console_settings where logo_url like '%/kaizen-photos/%'
    union select split_part(split_part(proof_url,'/kaizen-photos/',2),'?',1) from kaizen_payment_submissions where proof_url like '%/kaizen-photos/%'
    union select split_part(split_part(u,'/kaizen-photos/',2),'?',1)
      from kaizen_pm_tasks t
      cross join lateral jsonb_array_elements_text(case when jsonb_typeof(t.photos)='array' then t.photos else '[]'::jsonb end) u
      where u like '%/kaizen-photos/%'
  )
  select o.name
  from storage.objects o
  where o.bucket_id = 'kaizen-photos'
    and o.created_at < now() - p_older_than
    and not exists (select 1 from referenced r where r.name = o.name);
$$;

-- Only the edge function (service_role) may enumerate orphans. Name the roles —
-- REVOKE ... FROM PUBLIC alone leaves Supabase's explicit anon grant intact.
revoke all on function public.kaizen_list_orphan_photos(interval) from public, anon, authenticated;
grant execute on function public.kaizen_list_orphan_photos(interval) to service_role;
