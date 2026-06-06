-- Purchased add-ons (entitlements) per company, kept separate from package
-- `features` so changing/saving a package never wipes a purchased add-on.
ALTER TABLE kaizen_companies ADD COLUMN IF NOT EXISTS addons jsonb NOT NULL DEFAULT '{}'::jsonb;
NOTIFY pgrst, 'reload schema';
