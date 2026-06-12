-- Routine Roster v2 — order-ahead scheduling, variants, per-routine person-in-
-- charge, acknowledgement timeline, and per-user notification mutes.
-- All additive: new columns default to today's same-day behaviour.

-- ── Templates ────────────────────────────────────────────────────────────────
ALTER TABLE kaizen_rr_templates
  -- Order N days before the service date (welcome drink/fruit = 1). 0 = same day.
  ADD COLUMN IF NOT EXISTS lead_days int NOT NULL DEFAULT 0,
  -- Evening order window on the order day (e.g. 17:00–22:00). Informational + soft.
  ADD COLUMN IF NOT EXISTS order_open time,
  ADD COLUMN IF NOT EXISTS order_close time,
  -- Bulk unit shown next to the quantity, e.g. "gallon" → "2 gallon".
  ADD COLUMN IF NOT EXISTS unit_label text,
  -- Per-room variant catalogue: [{ "code":"V1", "label":"Tropical", "label_th":"..." }]
  ADD COLUMN IF NOT EXISTS variants jsonb,
  -- Person in charge on the requesting side. 'department' = anyone in the
  -- requesting department; 'users' = the specific people in pic_ids.
  ADD COLUMN IF NOT EXISTS pic_mode text NOT NULL DEFAULT 'department'
    CHECK (pic_mode IN ('department', 'users')),
  ADD COLUMN IF NOT EXISTS pic_ids uuid[],
  -- Optional daily reminder time for the assigned PIC (e.g. 17:00 "place tomorrow's order").
  ADD COLUMN IF NOT EXISTS remind_at time;

-- ── Orders ───────────────────────────────────────────────────────────────────
-- order_date is the SERVICE date (when the item is needed/delivered). For a
-- lead-day routine the order is placed the evening before but order_date stays
-- the service date.
ALTER TABLE kaizen_rr_orders
  ADD COLUMN IF NOT EXISTS unit_label text;

-- ── Order items (per room) ───────────────────────────────────────────────────
ALTER TABLE kaizen_rr_order_items
  ADD COLUMN IF NOT EXISTS variant text;

-- ── Acknowledgement timeline ─────────────────────────────────────────────────
-- Every meaningful action on an order: placed, accepted, delivered, confirmed,
-- reassigned, room ticked, reminded. Gives the "who acknowledged & approved" log.
CREATE TABLE IF NOT EXISTS kaizen_rr_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES kaizen_companies(id) ON DELETE CASCADE,
  order_id uuid NOT NULL REFERENCES kaizen_rr_orders(id) ON DELETE CASCADE,
  actor_id uuid,
  action text NOT NULL,
  detail text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS kaizen_rr_events_order_idx ON kaizen_rr_events (order_id, created_at);

-- ── Per-user notification mutes ──────────────────────────────────────────────
-- A row means this user silenced this routine's reminders for themselves. Only
-- managers / super admins may create them; the app refuses to mute a staff
-- member who is the routine's assigned person-in-charge.
CREATE TABLE IF NOT EXISTS kaizen_rr_mutes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES kaizen_companies(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  template_id uuid NOT NULL REFERENCES kaizen_rr_templates(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, template_id)
);

ALTER TABLE kaizen_rr_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE kaizen_rr_mutes  ENABLE ROW LEVEL SECURITY;

-- Events: any company member reads; inserts are company-scoped (app writes them).
CREATE POLICY kre_select ON kaizen_rr_events FOR SELECT
  USING (company_id IN (SELECT kaizen_user_company_ids()));
CREATE POLICY kre_insert ON kaizen_rr_events FOR INSERT
  WITH CHECK (company_id IN (SELECT kaizen_user_company_ids()));

-- Mutes: a user sees and manages only their own mute rows (within their company).
CREATE POLICY krm_select ON kaizen_rr_mutes FOR SELECT
  USING (company_id IN (SELECT kaizen_user_company_ids()));
CREATE POLICY krm_insert ON kaizen_rr_mutes FOR INSERT
  WITH CHECK (user_id = auth.uid() AND company_id IN (SELECT kaizen_user_company_ids()));
CREATE POLICY krm_delete ON kaizen_rr_mutes FOR DELETE
  USING (user_id = auth.uid());

-- Allow the new per-room-with-variants order type (the v1 CHECK predated it).
ALTER TABLE kaizen_rr_templates DROP CONSTRAINT IF EXISTS kaizen_rr_templates_order_type_check;
ALTER TABLE kaizen_rr_templates ADD CONSTRAINT kaizen_rr_templates_order_type_check
  CHECK (order_type IN ('bulk', 'per_room', 'per_room_variants'));
ALTER TABLE kaizen_rr_orders DROP CONSTRAINT IF EXISTS kaizen_rr_orders_order_type_check;
ALTER TABLE kaizen_rr_orders ADD CONSTRAINT kaizen_rr_orders_order_type_check
  CHECK (order_type IN ('bulk', 'per_room', 'per_room_variants'));
