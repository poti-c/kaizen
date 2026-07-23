-- Scheduled orphan-photo sweep: quarterly cron.
--
-- Invokes the kaizen-orphan-sweep edge function every 3 months (03:00 UTC on the
-- 1st of Jan/Apr/Jul/Oct) via pg_net, passing the shared secret from
-- kaizen_maintenance_config. The function deletes orphans older than 7 days —
-- leaving recent uploads alone so an in-flight resolve draft (persisted photo URL
-- not yet attached) is never destroyed.
--
-- URL is this project's fixed Functions endpoint (same convention as the push
-- trigger). Idempotent; safe to run against live.

create extension if not exists pg_net;
create extension if not exists pg_cron;

select cron.unschedule('kaizen-orphan-sweep')
where exists (select 1 from cron.job where jobname = 'kaizen-orphan-sweep');

select cron.schedule(
  'kaizen-orphan-sweep',
  '0 3 1 1,4,7,10 *',
  $CRON$
  select net.http_post(
    url := 'https://znxqmurhjtyfsotcorfj.supabase.co/functions/v1/kaizen-orphan-sweep',
    headers := jsonb_build_object(
      'Content-Type','application/json',
      'x-sweep-secret', (select value from public.kaizen_maintenance_config where key='orphan_sweep_secret')
    ),
    body := '{}'::jsonb
  );
  $CRON$
);
