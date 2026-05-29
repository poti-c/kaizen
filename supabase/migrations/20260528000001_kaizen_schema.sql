-- Na Nirand Kaizen System — Full Schema
-- Project: uwswaeazowhtrpktakhx (separate tables from the main website)

-- ============================================================
-- PROFILES
-- ============================================================
CREATE TABLE IF NOT EXISTS kaizen_profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  full_name TEXT NOT NULL,
  username TEXT,
  email TEXT,
  role TEXT NOT NULL CHECK (role IN ('super_admin', 'manager', 'staff')),
  department TEXT NOT NULL CHECK (department IN (
    'top_management','front_office','sales_team','house_keeping',
    'human_resource','engineering_team','restaurant','kitchen','accounting'
  )),
  is_active BOOLEAN NOT NULL DEFAULT true,
  avatar_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS kaizen_profiles_username_dept
  ON kaizen_profiles (username, department)
  WHERE username IS NOT NULL AND role = 'staff';

-- ============================================================
-- CASES
-- ============================================================
CREATE TABLE IF NOT EXISTS kaizen_cases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_number TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  department TEXT NOT NULL CHECK (department IN (
    'top_management','front_office','sales_team','house_keeping',
    'human_resource','engineering_team','restaurant','kitchen','accounting'
  )),
  created_by UUID REFERENCES kaizen_profiles(id),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN (
    'open','assigned','in_progress','pending_manager_approval',
    'pending_admin_approval','closed','reopened'
  )),
  priority TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('low','medium','high','critical')),
  proposed_solution TEXT,
  assigned_departments TEXT[],
  resolved_by UUID REFERENCES kaizen_profiles(id),
  manager_approved_by UUID REFERENCES kaizen_profiles(id),
  admin_approved_by UUID REFERENCES kaizen_profiles(id),
  manager_approved_at TIMESTAMPTZ,
  admin_approved_at TIMESTAMPTZ,
  resolved_at TIMESTAMPTZ,
  closed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS kaizen_cases_status_idx ON kaizen_cases (status);
CREATE INDEX IF NOT EXISTS kaizen_cases_department_idx ON kaizen_cases (department);
CREATE INDEX IF NOT EXISTS kaizen_cases_priority_idx ON kaizen_cases (priority);
CREATE INDEX IF NOT EXISTS kaizen_cases_created_at_idx ON kaizen_cases (created_at DESC);

-- ============================================================
-- CASE PHOTOS
-- ============================================================
CREATE TABLE IF NOT EXISTS kaizen_case_photos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id UUID NOT NULL REFERENCES kaizen_cases(id) ON DELETE CASCADE,
  photo_url TEXT NOT NULL,
  photo_type TEXT NOT NULL CHECK (photo_type IN ('problem', 'resolution')),
  uploaded_by UUID REFERENCES kaizen_profiles(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS kaizen_case_photos_case_idx ON kaizen_case_photos (case_id);

-- ============================================================
-- CASE ASSIGNMENTS
-- ============================================================
CREATE TABLE IF NOT EXISTS kaizen_case_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id UUID NOT NULL REFERENCES kaizen_cases(id) ON DELETE CASCADE,
  department TEXT NOT NULL,
  assigned_staff UUID REFERENCES kaizen_profiles(id),
  assigned_by UUID REFERENCES kaizen_profiles(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','acknowledged','in_progress','completed')),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (case_id, department)
);

-- ============================================================
-- CASE TIMELINE
-- ============================================================
CREATE TABLE IF NOT EXISTS kaizen_case_timeline (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id UUID NOT NULL REFERENCES kaizen_cases(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  description TEXT,
  performed_by UUID REFERENCES kaizen_profiles(id),
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS kaizen_timeline_case_idx ON kaizen_case_timeline (case_id, created_at);

-- ============================================================
-- NOTIFICATIONS
-- ============================================================
CREATE TABLE IF NOT EXISTS kaizen_notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES kaizen_profiles(id) ON DELETE CASCADE,
  case_id UUID REFERENCES kaizen_cases(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  is_read BOOLEAN NOT NULL DEFAULT false,
  notification_type TEXT NOT NULL DEFAULT 'info',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS kaizen_notifications_user_idx ON kaizen_notifications (user_id, is_read, created_at DESC);

-- ============================================================
-- SETTINGS
-- ============================================================
CREATE TABLE IF NOT EXISTS kaizen_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key TEXT UNIQUE NOT NULL,
  value JSONB NOT NULL,
  updated_by UUID REFERENCES kaizen_profiles(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO kaizen_settings (key, value) VALUES
  ('primary_color', '"#1e3a5f"'),
  ('accent_color',  '"#c9a84c"'),
  ('sidebar_color', '"#0f2744"')
ON CONFLICT (key) DO NOTHING;

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================
ALTER TABLE kaizen_profiles      ENABLE ROW LEVEL SECURITY;
ALTER TABLE kaizen_cases         ENABLE ROW LEVEL SECURITY;
ALTER TABLE kaizen_case_photos   ENABLE ROW LEVEL SECURITY;
ALTER TABLE kaizen_case_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE kaizen_case_timeline ENABLE ROW LEVEL SECURITY;
ALTER TABLE kaizen_notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE kaizen_settings      ENABLE ROW LEVEL SECURITY;

-- Helper functions
CREATE OR REPLACE FUNCTION kaizen_current_role()
RETURNS TEXT LANGUAGE SQL SECURITY DEFINER STABLE AS $$
  SELECT role FROM kaizen_profiles WHERE id = auth.uid()
$$;

CREATE OR REPLACE FUNCTION kaizen_current_dept()
RETURNS TEXT LANGUAGE SQL SECURITY DEFINER STABLE AS $$
  SELECT department FROM kaizen_profiles WHERE id = auth.uid()
$$;

-- Profiles
CREATE POLICY "kzn_profiles_select"        ON kaizen_profiles FOR SELECT USING (true);
CREATE POLICY "kzn_profiles_insert_admin"  ON kaizen_profiles FOR INSERT WITH CHECK (kaizen_current_role() = 'super_admin');
CREATE POLICY "kzn_profiles_update"        ON kaizen_profiles FOR UPDATE USING (id = auth.uid() OR kaizen_current_role() = 'super_admin');
CREATE POLICY "kzn_profiles_delete_admin"  ON kaizen_profiles FOR DELETE USING (kaizen_current_role() = 'super_admin');

-- Cases
CREATE POLICY "kzn_cases_select" ON kaizen_cases FOR SELECT USING (
  kaizen_current_role() IN ('super_admin', 'manager')
  OR (kaizen_current_role() = 'staff' AND department = kaizen_current_dept())
);
CREATE POLICY "kzn_cases_insert" ON kaizen_cases FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);
CREATE POLICY "kzn_cases_update" ON kaizen_cases FOR UPDATE USING (
  kaizen_current_role() IN ('super_admin', 'manager')
  OR (kaizen_current_role() = 'staff' AND department = kaizen_current_dept())
);
CREATE POLICY "kzn_cases_delete" ON kaizen_cases FOR DELETE USING (kaizen_current_role() = 'super_admin');

-- Photos
CREATE POLICY "kzn_photos_select" ON kaizen_case_photos FOR SELECT USING (true);
CREATE POLICY "kzn_photos_insert" ON kaizen_case_photos FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);

-- Assignments
CREATE POLICY "kzn_assignments_select" ON kaizen_case_assignments FOR SELECT USING (true);
CREATE POLICY "kzn_assignments_insert"  ON kaizen_case_assignments FOR INSERT WITH CHECK (kaizen_current_role() IN ('super_admin', 'manager'));
CREATE POLICY "kzn_assignments_update"  ON kaizen_case_assignments FOR UPDATE USING (kaizen_current_role() IN ('super_admin', 'manager'));

-- Timeline
CREATE POLICY "kzn_timeline_select" ON kaizen_case_timeline FOR SELECT USING (true);
CREATE POLICY "kzn_timeline_insert" ON kaizen_case_timeline FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);

-- Notifications
CREATE POLICY "kzn_notifs_select" ON kaizen_notifications FOR SELECT USING (user_id = auth.uid() OR kaizen_current_role() = 'super_admin');
CREATE POLICY "kzn_notifs_insert" ON kaizen_notifications FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);
CREATE POLICY "kzn_notifs_update" ON kaizen_notifications FOR UPDATE USING (user_id = auth.uid());

-- Settings
CREATE POLICY "kzn_settings_select" ON kaizen_settings FOR SELECT USING (true);
CREATE POLICY "kzn_settings_insert" ON kaizen_settings FOR INSERT WITH CHECK (kaizen_current_role() = 'super_admin');
CREATE POLICY "kzn_settings_update" ON kaizen_settings FOR UPDATE USING (kaizen_current_role() = 'super_admin');

-- ============================================================
-- STORAGE BUCKET
-- ============================================================
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'kaizen-photos',
  'kaizen-photos',
  true,
  10485760,  -- 10 MB per file
  ARRAY['image/jpeg','image/png','image/webp','image/gif']
)
ON CONFLICT (id) DO NOTHING;

-- Storage RLS policies
CREATE POLICY "kzn_storage_upload" ON storage.objects
  FOR INSERT WITH CHECK (
    bucket_id = 'kaizen-photos'
    AND auth.uid() IS NOT NULL
  );

CREATE POLICY "kzn_storage_read" ON storage.objects
  FOR SELECT USING (bucket_id = 'kaizen-photos');

CREATE POLICY "kzn_storage_delete" ON storage.objects
  FOR DELETE USING (
    bucket_id = 'kaizen-photos'
    AND auth.uid() IS NOT NULL
  );
