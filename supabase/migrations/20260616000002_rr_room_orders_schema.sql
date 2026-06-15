-- Routine Roster ROOM ORDERS schema (these tables previously existed only in the live DB
-- with no migration). Idempotent: IF NOT EXISTS tables + drop/recreate policies, so applying
-- against the live project is a no-op for data and only (re)asserts the RLS policies.

CREATE TABLE IF NOT EXISTS kaizen_rr_room_orders (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL,
  order_date    date NOT NULL,
  status        text NOT NULL DEFAULT 'draft',     -- draft | submitted
  submitted_by  uuid,
  submitted_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  room_statuses jsonb NOT NULL DEFAULT '{}'::jsonb, -- { roomNo: 'checkin'|'occupied'|'empty'|'oo' }
  UNIQUE (company_id, order_date)
);

CREATE TABLE IF NOT EXISTS kaizen_rr_room_lines (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_order_id     uuid NOT NULL REFERENCES kaizen_rr_room_orders(id) ON DELETE CASCADE,
  company_id        uuid NOT NULL,
  order_date        date NOT NULL,
  room_no           text NOT NULL,
  room_type         text,
  category          text,
  slot              text,
  item              text,
  fulfill_department text NOT NULL,
  serving_at        text,
  line_type         text NOT NULL DEFAULT 'delivery',  -- delivery | checklist
  source            text NOT NULL DEFAULT 'default',    -- default | special
  note              text,
  status            text NOT NULL DEFAULT 'pending',    -- pending | acknowledged | done
  approval_status   text NOT NULL DEFAULT 'approved',   -- approved | pending | auto | rejected
  acknowledged_by   uuid,
  acknowledged_at   timestamptz,
  delivered_by      uuid,
  delivered_at      timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  active            boolean NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS kaizen_rr_room_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL,
  room_order_id uuid NOT NULL REFERENCES kaizen_rr_room_orders(id) ON DELETE CASCADE,
  order_date    date NOT NULL,
  actor_id      uuid,
  action        text NOT NULL,
  detail        text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS kaizen_rr_room_lines_order_idx  ON kaizen_rr_room_lines (room_order_id);
CREATE INDEX IF NOT EXISTS kaizen_rr_room_lines_lookup_idx ON kaizen_rr_room_lines (company_id, order_date, fulfill_department);
CREATE INDEX IF NOT EXISTS kaizen_rr_room_events_order_idx ON kaizen_rr_room_events (room_order_id);

ALTER TABLE kaizen_rr_room_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE kaizen_rr_room_lines  ENABLE ROW LEVEL SECURITY;
ALTER TABLE kaizen_rr_room_events ENABLE ROW LEVEL SECURITY;

-- ── Room orders: tenant-scoped; only order-placers (Top Management / Front Office)
--    create or edit an order; managers may also delete. ──
DROP POLICY IF EXISTS "krro_select" ON kaizen_rr_room_orders;
CREATE POLICY "krro_select" ON kaizen_rr_room_orders FOR SELECT
  USING (company_id IN (SELECT kaizen_user_company_ids()));
DROP POLICY IF EXISTS "krro_insert" ON kaizen_rr_room_orders;
CREATE POLICY "krro_insert" ON kaizen_rr_room_orders FOR INSERT
  WITH CHECK (company_id IN (SELECT kaizen_user_company_ids())
    AND (kaizen_current_role() = 'super_admin' OR kaizen_current_dept() = 'front_office'));
DROP POLICY IF EXISTS "krro_update" ON kaizen_rr_room_orders;
CREATE POLICY "krro_update" ON kaizen_rr_room_orders FOR UPDATE
  USING (company_id IN (SELECT kaizen_user_company_ids())
    AND (kaizen_current_role() = 'super_admin' OR kaizen_current_dept() = 'front_office'));
DROP POLICY IF EXISTS "krro_delete" ON kaizen_rr_room_orders;
CREATE POLICY "krro_delete" ON kaizen_rr_room_orders FOR DELETE
  USING (company_id IN (SELECT kaizen_user_company_ids())
    AND kaizen_current_role() IN ('super_admin', 'manager'));

-- ── Room lines: tenant-scoped. Within a company, placers edit and fulfilling-dept
--    members tick/acknowledge their own lines (escalation runs across depts, so writes
--    are not dept-pinned here — defense is the company scope above). ──
DROP POLICY IF EXISTS "krrl_select" ON kaizen_rr_room_lines;
CREATE POLICY "krrl_select" ON kaizen_rr_room_lines FOR SELECT
  USING (company_id IN (SELECT kaizen_user_company_ids()));
DROP POLICY IF EXISTS "krrl_insert" ON kaizen_rr_room_lines;
CREATE POLICY "krrl_insert" ON kaizen_rr_room_lines FOR INSERT
  WITH CHECK (company_id IN (SELECT kaizen_user_company_ids())
    AND (kaizen_current_role() = 'super_admin' OR kaizen_current_dept() = 'front_office'));
DROP POLICY IF EXISTS "krrl_update" ON kaizen_rr_room_lines;
CREATE POLICY "krrl_update" ON kaizen_rr_room_lines FOR UPDATE
  USING (company_id IN (SELECT kaizen_user_company_ids()));
DROP POLICY IF EXISTS "krrl_delete" ON kaizen_rr_room_lines;
CREATE POLICY "krrl_delete" ON kaizen_rr_room_lines FOR DELETE
  USING (company_id IN (SELECT kaizen_user_company_ids())
    AND (kaizen_current_role() = 'super_admin' OR kaizen_current_dept() = 'front_office'));

-- ── Room events: tenant-scoped append-only audit. ──
DROP POLICY IF EXISTS "krre_select" ON kaizen_rr_room_events;
CREATE POLICY "krre_select" ON kaizen_rr_room_events FOR SELECT
  USING (company_id IN (SELECT kaizen_user_company_ids()));
DROP POLICY IF EXISTS "krre_insert" ON kaizen_rr_room_events;
CREATE POLICY "krre_insert" ON kaizen_rr_room_events FOR INSERT
  WITH CHECK (company_id IN (SELECT kaizen_user_company_ids()));
