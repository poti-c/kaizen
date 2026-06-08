-- Guarantee every PAID-plan company has a subscription_end date.
--
-- Why: the "Current plan" countdown and the PMS add-on days-remaining counter
-- (src/components/PackagesExpansions.tsx) only render when subscription_end is
-- set. A company on gold/premium with a NULL subscription_end shows no counter
-- (and reads as open-ended). The normal payment-approval paths
-- (kaizen-pay, kaizen-console approve_payment) already set subscription_end,
-- but seeded/legacy rows could miss it. This trigger is the safety net so it
-- can never happen again, regardless of how the plan is changed.
--
-- Trial companies are intentionally left NULL: their end date is derived from
-- created_at + TRIAL_DAYS on the client (subscriptionInfo()).

create or replace function kaizen_default_subscription_end()
returns trigger
language plpgsql
as $$
begin
  -- Only act for paid plans missing an explicit end date.
  if new.plan is not null
     and new.plan <> 'trial'
     and new.subscription_end is null then
    new.subscription_end := (coalesce(new.created_at::date, current_date) + interval '1 year')::date;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_kaizen_default_subscription_end on kaizen_companies;
create trigger trg_kaizen_default_subscription_end
  before insert or update of plan, subscription_end, created_at
  on kaizen_companies
  for each row
  execute function kaizen_default_subscription_end();

-- Backfill any existing paid-plan rows that are currently missing an end date.
update kaizen_companies
set subscription_end = (created_at::date + interval '1 year')::date
where plan is not null
  and plan <> 'trial'
  and subscription_end is null;
