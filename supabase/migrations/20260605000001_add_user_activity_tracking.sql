-- Track user engagement: last app activity (heartbeat) and last login time.
ALTER TABLE public.kaizen_profiles
  ADD COLUMN IF NOT EXISTS last_active_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_login_at  timestamptz;
