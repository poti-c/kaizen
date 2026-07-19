-- Routine Roster: add a third stage — Requesting → Fulfilling → Delivery.
--
-- Delivery is OPTIONAL. `deliver_department IS NULL` means the template keeps the
-- existing two-stage behaviour, so every template that exists today keeps working
-- with no backfill. Only templates that opt in gain the extra hop.
--
-- This mirrors the two-hop pattern already used by kaizen_rr_room_lines
-- (20260627000000_rr_room_handoff.sql), except the new stage sits DOWNSTREAM of
-- fulfill_department rather than upstream of it, so fulfill_department keeps its
-- current meaning and no existing row changes shape.

-- ── templates ────────────────────────────────────────────────────────────────

alter table public.kaizen_rr_templates
  add column if not exists deliver_department text;

-- Per-stage person-in-charge. Today's single pic_mode/pic_ids pair is scoped to the
-- REQUESTING department (the editor draws its candidate list from it), so it becomes
-- the request_* pair. The old columns are left in place for one release so a rollback
-- doesn't lose data; a later migration drops them.
alter table public.kaizen_rr_templates
  add column if not exists request_pic_mode text not null default 'department',
  add column if not exists request_pic_ids  uuid[],
  add column if not exists fulfill_pic_mode text not null default 'department',
  add column if not exists fulfill_pic_ids  uuid[],
  add column if not exists deliver_pic_mode text not null default 'department',
  add column if not exists deliver_pic_ids  uuid[];

do $$ begin
  alter table public.kaizen_rr_templates
    add constraint kaizen_rr_templates_request_pic_mode_check
    check (request_pic_mode in ('department', 'users'));
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.kaizen_rr_templates
    add constraint kaizen_rr_templates_fulfill_pic_mode_check
    check (fulfill_pic_mode in ('department', 'users'));
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.kaizen_rr_templates
    add constraint kaizen_rr_templates_deliver_pic_mode_check
    check (deliver_pic_mode in ('department', 'users'));
exception when duplicate_object then null; end $$;

-- Carry the existing PIC config over to the requesting stage.
update public.kaizen_rr_templates
   set request_pic_mode = pic_mode,
       request_pic_ids  = pic_ids
 where pic_mode is not null
   and request_pic_mode = 'department'
   and request_pic_ids is null;

-- ── orders ───────────────────────────────────────────────────────────────────

-- Snapshot of the template's delivery stage at placement time, alongside the
-- request/fulfill snapshots that are already taken.
alter table public.kaizen_rr_orders
  add column if not exists deliver_department text,
  add column if not exists ready_by uuid references public.kaizen_profiles(id),
  add column if not exists ready_at timestamptz;

-- Widen the status vocabulary with 'ready' — fulfilling has finished and handed the
-- order to delivery, which has not yet completed it to the customer. Only three-stage
-- orders ever enter this state; two-stage orders go accepted → delivered as before.
alter table public.kaizen_rr_orders
  drop constraint if exists kaizen_rr_orders_status_check;

alter table public.kaizen_rr_orders
  add constraint kaizen_rr_orders_status_check
  check (status in ('pending', 'sent', 'accepted', 'ready', 'delivered', 'confirmed', 'cancelled'));

comment on column public.kaizen_rr_orders.deliver_department is
  'Final delivery stage. NULL = two-stage order (fulfilling delivers directly).';
comment on column public.kaizen_rr_orders.ready_at is
  'When fulfilling handed the order to delivery. Only set on three-stage orders.';
