-- Denormalise package config onto each company so the hotel app (which reads
-- kaizen_companies) can enforce user limits, the multi-company toggle, and
-- feature authorities without needing access to the service-role-only
-- kaizen_products table. Kept in sync by the kaizen-console edge function
-- whenever a plan is assigned or a package is edited.

ALTER TABLE kaizen_companies ADD COLUMN IF NOT EXISTS features      jsonb   NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE kaizen_companies ADD COLUMN IF NOT EXISTS multi_company boolean NOT NULL DEFAULT false;

-- Backfill every company from its matching package. Keep any manually-set
-- per-company limits (COALESCE), but take multi_company + features from the package.
UPDATE kaizen_companies c
SET max_managers  = COALESCE(c.max_managers, p.max_managers),
    max_staff     = COALESCE(c.max_staff,    p.max_staff),
    multi_company = COALESCE(p.multi_company, false),
    features      = COALESCE(p.features, '{}'::jsonb)
FROM kaizen_products p
WHERE p.kind = 'package' AND p.key = c.plan;
