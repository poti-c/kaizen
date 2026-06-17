-- Tighten DELETE on room orders to match INSERT/UPDATE. Previously krro_delete
-- allowed any role IN ('super_admin','manager'), so a fulfilling-department manager
-- (Restaurant/Kitchen/Housekeeping) — who is shown a "view only" banner and cannot
-- place or edit an order — could still DELETE a submitted order, cascading away all
-- room lines (with delivery progress) and history. Only order-placers (Top
-- Management / Front Office) may delete, the same set that creates and edits.

DROP POLICY IF EXISTS "krro_delete" ON kaizen_rr_room_orders;
CREATE POLICY "krro_delete" ON kaizen_rr_room_orders FOR DELETE
  USING (company_id IN (SELECT kaizen_user_company_ids())
    AND (kaizen_current_role() = 'super_admin' OR kaizen_current_dept() = 'front_office'));
