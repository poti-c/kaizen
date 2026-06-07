-- Promote the "Preventive Maintenance Scheduler" to a proper add-on product
-- (kind='addon', key='pms') so its price is managed under Console → Products →
-- Additional Costs and read live (by key) on the client Packages page.
UPDATE kaizen_products
   SET kind = 'addon', key = 'pms', duration_label = COALESCE(duration_label, '1 year')
 WHERE name ILIKE '%preventive maintenance%' AND COALESCE(key, '') <> 'pms';

NOTIFY pgrst, 'reload schema';
