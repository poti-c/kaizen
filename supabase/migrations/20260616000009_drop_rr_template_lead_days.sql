-- Drop lead_days from routine templates. With click-to-order, staff pick the
-- ready-by day (Today / Tomorrow) in the order popup, so a per-template
-- order-ahead setting is redundant. The popup now defaults to Tomorrow.
ALTER TABLE kaizen_rr_templates
  DROP COLUMN IF EXISTS lead_days;
