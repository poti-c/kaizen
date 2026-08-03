-- Routine-roster "add-up" orders.
--
-- 20260617000001_rr_orders_partial_unique.sql allows exactly one live order per
-- (template_id, order_date). That is the right guard against a routine being
-- double-sent by accident, but it also made a real workflow impossible: Front
-- Office sends ABF BOX for tomorrow (E-103, 2 Normal Box, ready 06:00), then an
-- add-up comes in later the same night (E-102/E-201/E-203, 5 Noham + 1 Noham
-- no-gluten, pickup 04:45). The second order is rejected as "already ordered
-- for that day" and the existing one cannot be amended after it is sent — so
-- the add-up leaves the system entirely: phone the kitchen, send a paper slip.
--
-- The add-up genuinely is a separate order (own rooms, own variants, own ready
-- time, own status, and the kitchen needs its own notification), so it gets its
-- own row rather than being merged into the parent.
--
--   is_add_up       identity. Drives the unique index, so an add-up never
--                   competes for the routine's one live slot.
--   parent_order_id grouping only, for display and the report.
--
-- Two columns rather than one deliberately: ON DELETE SET NULL is the right
-- behaviour for the parent being deleted (an add-up is real work and must
-- survive), but if uniqueness keyed off `parent_order_id IS NULL`, orphaning
-- two add-ups of the same routine+date would collide on the index and the
-- parent's DELETE would fail outright. `is_add_up` is stable under orphaning.

ALTER TABLE kaizen_rr_orders
  ADD COLUMN IF NOT EXISTS is_add_up boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS parent_order_id uuid REFERENCES kaizen_rr_orders(id) ON DELETE SET NULL;

-- A child must be flagged as one; a flagged row may be parentless (orphaned).
ALTER TABLE kaizen_rr_orders
  DROP CONSTRAINT IF EXISTS kaizen_rr_orders_add_up_ck;
ALTER TABLE kaizen_rr_orders
  ADD CONSTRAINT kaizen_rr_orders_add_up_ck
  CHECK (parent_order_id IS NULL OR is_add_up);

CREATE INDEX IF NOT EXISTS kaizen_rr_orders_parent_idx
  ON kaizen_rr_orders (parent_order_id) WHERE parent_order_id IS NOT NULL;

-- One live *primary* order per routine+date, unlimited add-ups beneath it.
DROP INDEX IF EXISTS kaizen_rr_orders_live_template_date_uidx;
CREATE UNIQUE INDEX IF NOT EXISTS kaizen_rr_orders_live_template_date_uidx
  ON kaizen_rr_orders (template_id, order_date)
  WHERE status <> 'cancelled' AND NOT is_add_up;
