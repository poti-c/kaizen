-- Two-stage room-order fulfillment (Kitchen prepares → Restaurant delivers).
-- A handoff line keeps fulfill_department as the FINAL deliverer and adds an optional
-- preparer. Single-stage lines leave prepare_department NULL and behave exactly as before.
-- Additive + idempotent: safe to apply against the live project with no data rewrite.

ALTER TABLE kaizen_rr_room_lines
  ADD COLUMN IF NOT EXISTS prepare_department text,            -- preparer (e.g. kitchen); NULL = single-stage
  ADD COLUMN IF NOT EXISTS prepared_by        uuid,            -- who marked it ready
  ADD COLUMN IF NOT EXISTS prepared_at        timestamptz;     -- when it was marked ready

-- status gains a 'ready' value for handoff lines (pending → ready → done). The column is
-- free-text with no CHECK constraint, so no enum change is needed.

-- Mirror the existing fulfill_department lookup index so a preparer's board query is fast.
CREATE INDEX IF NOT EXISTS kaizen_rr_room_lines_prepare_idx
  ON kaizen_rr_room_lines (company_id, order_date, prepare_department);
