-- Routine Roster add-on (addons.routine_roster, like addons.pms).
-- Daily inter-department orders with a confirmation chain:
--   pending → sent → accepted → delivered → confirmed
-- Templates auto-materialize into one order per day. Bulk orders carry a
-- quantity; per-room orders carry a room checklist (kaizen_rr_order_items).

CREATE TABLE IF NOT EXISTS kaizen_rr_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES kaizen_companies(id) ON DELETE CASCADE,
  name text NOT NULL,
  name_th text,
  request_department text NOT NULL,
  fulfill_department text NOT NULL,
  order_type text NOT NULL DEFAULT 'bulk' CHECK (order_type IN ('bulk', 'per_room')),
  -- Default item label; per-weekday override for varies-by-day items
  -- (e.g. turndown gifts): {"mon": "Dried mango", "tue": "Coconut cookie", ...}
  default_item text,
  item_by_weekday jsonb,
  due_time time NOT NULL DEFAULT '12:00',
  active boolean NOT NULL DEFAULT true,
  sort_order int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS kaizen_rr_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES kaizen_companies(id) ON DELETE CASCADE,
  template_id uuid REFERENCES kaizen_rr_templates(id) ON DELETE CASCADE,
  order_date date NOT NULL,
  title text NOT NULL,
  request_department text NOT NULL,
  fulfill_department text NOT NULL,
  order_type text NOT NULL DEFAULT 'bulk' CHECK (order_type IN ('bulk', 'per_room')),
  item_label text,
  quantity int,
  note text,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sent', 'accepted', 'delivered', 'confirmed', 'cancelled')),
  due_at timestamptz,
  sent_by uuid,       sent_at timestamptz,
  accepted_by uuid,   accepted_at timestamptz,
  delivered_by uuid,  delivered_at timestamptz,
  confirmed_by uuid,  confirmed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (template_id, order_date)
);

CREATE TABLE IF NOT EXISTS kaizen_rr_order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES kaizen_rr_orders(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES kaizen_companies(id) ON DELETE CASCADE,
  room_no text NOT NULL,
  item_label text,
  delivered boolean NOT NULL DEFAULT false,
  delivered_by uuid,
  delivered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS kaizen_rr_orders_day_idx ON kaizen_rr_orders (company_id, order_date);
CREATE INDEX IF NOT EXISTS kaizen_rr_items_order_idx ON kaizen_rr_order_items (order_id);

ALTER TABLE kaizen_rr_templates   ENABLE ROW LEVEL SECURITY;
ALTER TABLE kaizen_rr_orders      ENABLE ROW LEVEL SECURITY;
ALTER TABLE kaizen_rr_order_items ENABLE ROW LEVEL SECURITY;

-- Templates: visible to all company members; managed by managers/super admins.
CREATE POLICY krt_select ON kaizen_rr_templates FOR SELECT
  USING (company_id IN (SELECT kaizen_user_company_ids()));
CREATE POLICY krt_insert ON kaizen_rr_templates FOR INSERT
  WITH CHECK (company_id IN (SELECT kaizen_user_company_ids())
    AND EXISTS (SELECT 1 FROM kaizen_profiles p WHERE p.id = auth.uid() AND p.role IN ('super_admin', 'manager')));
CREATE POLICY krt_update ON kaizen_rr_templates FOR UPDATE
  USING (company_id IN (SELECT kaizen_user_company_ids())
    AND EXISTS (SELECT 1 FROM kaizen_profiles p WHERE p.id = auth.uid() AND p.role IN ('super_admin', 'manager')));
CREATE POLICY krt_delete ON kaizen_rr_templates FOR DELETE
  USING (company_id IN (SELECT kaizen_user_company_ids())
    AND EXISTS (SELECT 1 FROM kaizen_profiles p WHERE p.id = auth.uid() AND p.role IN ('super_admin', 'manager')));

-- Orders & items: any company member can read and write — staff in the
-- fulfilling department accept orders and tick room deliveries. The app
-- enforces workflow semantics; deletes stay manager-only.
CREATE POLICY kro_select ON kaizen_rr_orders FOR SELECT
  USING (company_id IN (SELECT kaizen_user_company_ids()));
CREATE POLICY kro_insert ON kaizen_rr_orders FOR INSERT
  WITH CHECK (company_id IN (SELECT kaizen_user_company_ids()));
CREATE POLICY kro_update ON kaizen_rr_orders FOR UPDATE
  USING (company_id IN (SELECT kaizen_user_company_ids()));
CREATE POLICY kro_delete ON kaizen_rr_orders FOR DELETE
  USING (company_id IN (SELECT kaizen_user_company_ids())
    AND EXISTS (SELECT 1 FROM kaizen_profiles p WHERE p.id = auth.uid() AND p.role IN ('super_admin', 'manager')));

CREATE POLICY kri_select ON kaizen_rr_order_items FOR SELECT
  USING (company_id IN (SELECT kaizen_user_company_ids()));
CREATE POLICY kri_insert ON kaizen_rr_order_items FOR INSERT
  WITH CHECK (company_id IN (SELECT kaizen_user_company_ids()));
CREATE POLICY kri_update ON kaizen_rr_order_items FOR UPDATE
  USING (company_id IN (SELECT kaizen_user_company_ids()));
CREATE POLICY kri_delete ON kaizen_rr_order_items FOR DELETE
  USING (company_id IN (SELECT kaizen_user_company_ids())
    AND EXISTS (SELECT 1 FROM kaizen_profiles p WHERE p.id = auth.uid() AND p.role IN ('super_admin', 'manager')));
