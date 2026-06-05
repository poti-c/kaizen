-- Products catalog (packages, add-ons, future custom products) + promo codes,
-- managed in the System Console "Products" tab. Accessed only via the
-- kaizen-console edge function (service role), so RLS is on with no policies.

CREATE TABLE IF NOT EXISTS kaizen_products (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind          text NOT NULL DEFAULT 'package' CHECK (kind IN ('package','addon','custom')),
  key           text UNIQUE,            -- stable slug (e.g. 'trial','gold','premium','setup')
  name          text NOT NULL,
  description   text,
  price         numeric NOT NULL DEFAULT 0,
  currency      text NOT NULL DEFAULT 'THB',
  duration_label text,                  -- '30 days','1 month','1 year','Lifetime'…
  duration_days int,                    -- null = lifetime / not applicable
  max_managers  int,                    -- null = unlimited
  max_staff     int,                    -- null = unlimited
  multi_company boolean NOT NULL DEFAULT false,
  features      jsonb NOT NULL DEFAULT '{}'::jsonb,  -- { capability: bool }
  sort_order    int NOT NULL DEFAULT 0,
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS kaizen_promo_codes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code          text NOT NULL,
  discount_percent numeric NOT NULL DEFAULT 0,
  valid_from    date,
  valid_to      date,
  is_active     boolean NOT NULL DEFAULT true,
  notes         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Discount fields on generated forms (promo code applied at generation time)
ALTER TABLE kaizen_generated_forms ADD COLUMN IF NOT EXISTS discount_code text;
ALTER TABLE kaizen_generated_forms ADD COLUMN IF NOT EXISTS discount_percent numeric NOT NULL DEFAULT 0;
ALTER TABLE kaizen_generated_forms ADD COLUMN IF NOT EXISTS discount_amount  numeric NOT NULL DEFAULT 0;

-- Seed the three packages (keys match existing company.plan values so nothing
-- breaks; 'trial' now presents as "Starter") plus the Setup Cost add-on.
INSERT INTO kaizen_products (kind, key, name, description, price, duration_label, duration_days, max_managers, max_staff, multi_company, sort_order, features)
VALUES
 ('package','trial',   'Starter', 'Entry package for small teams',        0, '1 month', 30,  2,   10,   false, 1,
   '{"recurring_detection":true,"performance_analytics":false,"translation":false,"activity_log":false,"custom_theme":false,"priority_support":false}'::jsonb),
 ('package','gold',    'Gold',    'Core features for growing properties', 0, '1 year',  365, 5,   50,   false, 2,
   '{"recurring_detection":true,"performance_analytics":true,"translation":true,"activity_log":true,"custom_theme":false,"priority_support":false}'::jsonb),
 ('package','premium', 'Premium', 'All features unlocked',                0, '1 year',  365, NULL,NULL, true,  3,
   '{"recurring_detection":true,"performance_analytics":true,"translation":true,"activity_log":true,"custom_theme":true,"priority_support":true}'::jsonb),
 ('addon',  'setup',   'Setup Cost', 'One-time onboarding & setup',       0, NULL,      NULL, NULL,NULL, false, 10, '{}'::jsonb)
ON CONFLICT (key) DO NOTHING;

ALTER TABLE kaizen_products    ENABLE ROW LEVEL SECURITY;
ALTER TABLE kaizen_promo_codes ENABLE ROW LEVEL SECURITY;
