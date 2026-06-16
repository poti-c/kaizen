-- Allow managers to write the rr_items key in kaizen_settings for their own company.
-- All other keys (primary_color, accent_color, sidebar_color, etc.) remain super_admin only.

CREATE POLICY "kzn_settings_rr_items_manager_insert" ON kaizen_settings
  FOR INSERT WITH CHECK (
    key = 'rr_items'
    AND kaizen_current_role() IN ('super_admin', 'manager')
    AND company_id IN (SELECT kaizen_user_company_ids())
  );

CREATE POLICY "kzn_settings_rr_items_manager_update" ON kaizen_settings
  FOR UPDATE USING (
    key = 'rr_items'
    AND kaizen_current_role() IN ('super_admin', 'manager')
    AND company_id IN (SELECT kaizen_user_company_ids())
  );
