-- Push-notification coverage report for Top Management.
--
-- Motivation: department "notify all" delivers an in-app row to everyone, but a
-- device push only reaches users with a live kaizen_push_subscriptions row — and
-- most staff have none, so "not everyone gets notified" is invisible to admins.
-- RLS on kaizen_push_subscriptions is user_id = auth.uid(), so a super_admin
-- cannot read other users' subscriptions from the browser. This SECURITY DEFINER
-- function returns a per-member has_push flag, gated to super_admin (Top
-- Management) and to companies the caller belongs to.
--
-- Idempotent (create or replace); safe to run against live.

create or replace function public.kaizen_push_coverage(p_company_id uuid)
returns table (
  user_id    uuid,
  full_name  text,
  department text,
  role       text,
  has_push   boolean
)
language plpgsql
security definer
stable
set search_path = public
as $$
begin
  -- SECURITY DEFINER bypasses RLS — this function MUST authorize its own caller.
  -- Only Top Management (super_admin) may see other users' push coverage.
  if not exists (
    select 1 from public.kaizen_profiles
    where id = auth.uid() and role = 'super_admin'
  ) then
    raise exception 'not authorized';
  end if;

  -- And only for a company the caller is actually a member of.
  if p_company_id is null
     or p_company_id not in (select public.kaizen_user_company_ids()) then
    raise exception 'not authorized for company';
  end if;

  return query
    select
      p.id,
      p.full_name,
      p.department,
      p.role,
      exists (
        select 1 from public.kaizen_push_subscriptions s where s.user_id = p.id
      ) as has_push
    from public.kaizen_profiles p
    where p.company_id = p_company_id
      and p.is_active = true
      and p.deleted_at is null
      and p.role in ('staff', 'manager', 'super_admin')
    order by
      exists (select 1 from public.kaizen_push_subscriptions s where s.user_id = p.id) asc,
      p.department asc,
      p.full_name asc;
end;
$$;

-- Grants: the browser (an authenticated super_admin) calls this. Name the roles —
-- REVOKE ... FROM PUBLIC alone leaves Supabase's explicit anon grant intact.
revoke all on function public.kaizen_push_coverage(uuid) from public, anon, authenticated;
grant execute on function public.kaizen_push_coverage(uuid) to authenticated;
