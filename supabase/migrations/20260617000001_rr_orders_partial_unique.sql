-- Routine-roster orders: a cancelled order should NOT keep occupying the
-- (template_id, order_date) slot. The plain UNIQUE(template_id, order_date)
-- constraint blocked re-ordering a routine after it was cancelled, surfacing the
-- misleading "already ordered for that day" toast (the cancelled row is invisible
-- in the UI, which treats cancelled as not-ordered). Replace it with a partial
-- unique index that ignores cancelled rows, so at most one *live* order can exist
-- per routine+date while any number of cancelled rows may coexist harmlessly.

ALTER TABLE kaizen_rr_orders
  DROP CONSTRAINT IF EXISTS kaizen_rr_orders_template_id_order_date_key;

CREATE UNIQUE INDEX IF NOT EXISTS kaizen_rr_orders_live_template_date_uidx
  ON kaizen_rr_orders (template_id, order_date)
  WHERE status <> 'cancelled';
