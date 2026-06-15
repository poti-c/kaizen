-- Persist each user's UI language on their profile so SERVER-SIDE push notifications
-- (kaizen-push edge function) can be localized to the recipient, not just the in-app feed.
-- Client writes this from LanguageContext.setLang; null is treated as 'en'.
ALTER TABLE kaizen_profiles ADD COLUMN IF NOT EXISTS preferred_lang text;
