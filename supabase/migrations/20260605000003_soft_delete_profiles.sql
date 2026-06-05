-- Soft-delete marker: a removed user's profile row is KEPT (so their name
-- survives on historical cases, shown struck-through), but they can no longer
-- log in (is_active=false + auth ban) and are excluded from active lists.
ALTER TABLE public.kaizen_profiles
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
