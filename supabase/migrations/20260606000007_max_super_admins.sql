-- Per-package limit on Top Management (super_admin / owner) accounts.
-- Gold = 1, Premium = 3, Starter = 1 (blank/NULL = unlimited).
ALTER TABLE kaizen_products  ADD COLUMN IF NOT EXISTS max_super_admins integer;
ALTER TABLE kaizen_companies ADD COLUMN IF NOT EXISTS max_super_admins integer;

UPDATE kaizen_products
   SET max_super_admins = CASE key
     WHEN 'trial'   THEN 1
     WHEN 'gold'    THEN 1
     WHEN 'premium' THEN 3
     ELSE max_super_admins
   END
 WHERE kind = 'package';

-- Backfill every company from its matching package.
UPDATE kaizen_companies c
   SET max_super_admins = p.max_super_admins
  FROM kaizen_products p
 WHERE p.kind = 'package' AND p.key = c.plan;

NOTIFY pgrst, 'reload schema';
