-- Add preferred_lang to kaizen_profiles so push notifications can be
-- delivered in the user's chosen language (EN or ไทย).
-- Defaults to NULL which the push function treats as 'en'.
ALTER TABLE kaizen_profiles
  ADD COLUMN IF NOT EXISTS preferred_lang text
  CHECK (preferred_lang IN ('en', 'th'));
