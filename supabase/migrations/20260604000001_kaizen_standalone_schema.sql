-- Kaizen System — Standalone Full Schema
-- Applied to project: znxqmurhjtyfsotcorfj (Kaizen System — standalone)
-- This migration supersedes the previous Na Nirand-hosted schema.
-- All kaizen tables, functions, triggers, RLS, storage, and seed data.

-- ============================================================
-- EXTENSIONS
-- ============================================================
CREATE EXTENSION IF NOT EXISTS pg_net;

-- ============================================================
-- COMPANIES
-- ============================================================
CREATE TABLE IF NOT EXISTS kaizen_companies (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT NOT NULL,
  slug       TEXT UNIQUE NOT NULL,
  logo_url   TEXT,
  is_active  BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO kaizen_companies (id, name, slug)
VALUES ('a0000000-0000-0000-0000-000000000001', 'Na Nirand', 'na-nirand')
ON CONFLICT (slug) DO NOTHING;

-- ============================================================
-- PROFILES
-- ============================================================
CREATE TABLE IF NOT EXISTS kaizen_profiles (
  id         UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  full_name  TEXT NOT NULL,
  username   TEXT,
  email      TEXT,
  role       TEXT NOT NULL CHECK (role IN ('super_admin','manager','staff')),
  department TEXT NOT NULL CHECK (department IN (
    'top_management','front_office','sales_team','house_keeping',
    'human_resource','engineering_team','restaurant','kitchen','accounting'
  )),
  is_active  BOOLEAN NOT NULL DEFAULT true,
  avatar_url TEXT,
  company_id UUID REFERENCES kaizen_companies(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS kaizen_profiles_username_dept
  ON kaizen_profiles (username, department)
  WHERE username IS NOT NULL AND role = 'staff';

-- ============================================================
-- SUPER ADMIN → COMPANIES MAPPING
-- ============================================================
CREATE TABLE IF NOT EXISTS kaizen_super_admin_companies (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  super_admin_id UUID NOT NULL REFERENCES kaizen_profiles(id) ON DELETE CASCADE,
  company_id     UUID NOT NULL REFERENCES kaizen_companies(id) ON DELETE CASCADE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (super_admin_id, company_id)
);

-- ============================================================
-- CASES
-- ============================================================
CREATE TABLE IF NOT EXISTS kaizen_cases (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_number           TEXT UNIQUE NOT NULL,
  title                 TEXT NOT NULL,
  description           TEXT NOT NULL,
  department            TEXT NOT NULL CHECK (department IN (
    'top_management','front_office','sales_team','house_keeping',
    'human_resource','engineering_team','restaurant','kitchen','accounting'
  )),
  created_by            UUID REFERENCES kaizen_profiles(id),
  status                TEXT NOT NULL DEFAULT 'open' CHECK (status IN (
    'open','assigned','in_progress','pending_manager_approval',
    'pending_admin_approval','closed','reopened'
  )),
  priority              TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('low','medium','high','critical')),
  proposed_solution     TEXT,
  assigned_departments  TEXT[],
  resolved_by           UUID REFERENCES kaizen_profiles(id),
  manager_approved_by   UUID REFERENCES kaizen_profiles(id),
  admin_approved_by     UUID REFERENCES kaizen_profiles(id),
  manager_approved_at   TIMESTAMPTZ,
  admin_approved_at     TIMESTAMPTZ,
  resolved_at           TIMESTAMPTZ,
  closed_at             TIMESTAMPTZ,
  due_date              DATE,
  category              TEXT,
  is_recurring          BOOLEAN DEFAULT false,
  linked_case_ids       TEXT[] DEFAULT '{}',
  location              TEXT,
  location_other        TEXT,
  category_other        TEXT,
  resolution_note       TEXT,
  company_id            UUID REFERENCES kaizen_companies(id),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS kaizen_cases_status_idx      ON kaizen_cases (status);
CREATE INDEX IF NOT EXISTS kaizen_cases_department_idx  ON kaizen_cases (department);
CREATE INDEX IF NOT EXISTS kaizen_cases_priority_idx    ON kaizen_cases (priority);
CREATE INDEX IF NOT EXISTS kaizen_cases_created_at_idx  ON kaizen_cases (created_at DESC);
CREATE INDEX IF NOT EXISTS kaizen_cases_company_idx     ON kaizen_cases (company_id);

-- ============================================================
-- CASE PHOTOS
-- ============================================================
CREATE TABLE IF NOT EXISTS kaizen_case_photos (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id     UUID NOT NULL REFERENCES kaizen_cases(id) ON DELETE CASCADE,
  photo_url   TEXT NOT NULL,
  photo_type  TEXT NOT NULL CHECK (photo_type IN ('problem','resolution')),
  uploaded_by UUID REFERENCES kaizen_profiles(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS kaizen_case_photos_case_idx ON kaizen_case_photos (case_id);

-- ============================================================
-- CASE ASSIGNMENTS
-- ============================================================
CREATE TABLE IF NOT EXISTS kaizen_case_assignments (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id        UUID NOT NULL REFERENCES kaizen_cases(id) ON DELETE CASCADE,
  department     TEXT NOT NULL,
  assigned_staff UUID REFERENCES kaizen_profiles(id),
  assigned_by    UUID REFERENCES kaizen_profiles(id),
  status         TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','acknowledged','in_progress','completed')),
  notes          TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (case_id, department)
);

-- ============================================================
-- CASE TIMELINE
-- ============================================================
CREATE TABLE IF NOT EXISTS kaizen_case_timeline (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id      UUID NOT NULL REFERENCES kaizen_cases(id) ON DELETE CASCADE,
  action       TEXT NOT NULL,
  description  TEXT,
  performed_by UUID REFERENCES kaizen_profiles(id),
  metadata     JSONB NOT NULL DEFAULT '{}',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS kaizen_timeline_case_idx ON kaizen_case_timeline (case_id, created_at);

-- ============================================================
-- CASE COMMENTS
-- ============================================================
CREATE TABLE IF NOT EXISTS kaizen_case_comments (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id    UUID NOT NULL REFERENCES kaizen_cases(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES kaizen_profiles(id),
  content    TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS kaizen_case_comments_case_idx ON kaizen_case_comments (case_id);

-- ============================================================
-- NOTIFICATIONS
-- ============================================================
CREATE TABLE IF NOT EXISTS kaizen_notifications (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES kaizen_profiles(id) ON DELETE CASCADE,
  case_id           UUID REFERENCES kaizen_cases(id) ON DELETE CASCADE,
  title             TEXT NOT NULL,
  message           TEXT NOT NULL,
  is_read           BOOLEAN NOT NULL DEFAULT false,
  notification_type TEXT NOT NULL DEFAULT 'info',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS kaizen_notifications_user_idx ON kaizen_notifications (user_id, is_read, created_at DESC);

-- ============================================================
-- PUSH SUBSCRIPTIONS
-- ============================================================
CREATE TABLE IF NOT EXISTS kaizen_push_subscriptions (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES kaizen_profiles(id) ON DELETE CASCADE,
  endpoint   TEXT NOT NULL,
  p256dh     TEXT NOT NULL,
  auth       TEXT NOT NULL,
  user_agent TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (user_id, endpoint)
);

-- ============================================================
-- SETTINGS
-- ============================================================
CREATE TABLE IF NOT EXISTS kaizen_settings (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key        TEXT NOT NULL,
  value      JSONB NOT NULL,
  updated_by UUID REFERENCES kaizen_profiles(id),
  company_id UUID REFERENCES kaizen_companies(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT kaizen_settings_key_company_key UNIQUE (key, company_id)
);

INSERT INTO kaizen_settings (key, value, company_id) VALUES
  ('primary_color', '"#0891b2"', 'a0000000-0000-0000-0000-000000000001'),
  ('accent_color',  '"#06b6d4"', 'a0000000-0000-0000-0000-000000000001'),
  ('sidebar_color', '"#1c2b3a"', 'a0000000-0000-0000-0000-000000000001')
ON CONFLICT (key, company_id) DO NOTHING;

-- ============================================================
-- ROW LEVEL SECURITY — enable
-- ============================================================
ALTER TABLE kaizen_companies             ENABLE ROW LEVEL SECURITY;
ALTER TABLE kaizen_profiles              ENABLE ROW LEVEL SECURITY;
ALTER TABLE kaizen_super_admin_companies ENABLE ROW LEVEL SECURITY;
ALTER TABLE kaizen_cases                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE kaizen_case_photos           ENABLE ROW LEVEL SECURITY;
ALTER TABLE kaizen_case_assignments      ENABLE ROW LEVEL SECURITY;
ALTER TABLE kaizen_case_timeline         ENABLE ROW LEVEL SECURITY;
ALTER TABLE kaizen_case_comments         ENABLE ROW LEVEL SECURITY;
ALTER TABLE kaizen_notifications         ENABLE ROW LEVEL SECURITY;
ALTER TABLE kaizen_push_subscriptions    ENABLE ROW LEVEL SECURITY;
ALTER TABLE kaizen_settings              ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- HELPER FUNCTIONS
-- ============================================================
CREATE OR REPLACE FUNCTION kaizen_current_role()
RETURNS TEXT LANGUAGE SQL SECURITY DEFINER STABLE AS $$
  SELECT role FROM public.kaizen_profiles WHERE id = auth.uid()
$$;

CREATE OR REPLACE FUNCTION kaizen_current_dept()
RETURNS TEXT LANGUAGE SQL SECURITY DEFINER STABLE AS $$
  SELECT department FROM public.kaizen_profiles WHERE id = auth.uid()
$$;

REVOKE EXECUTE ON FUNCTION kaizen_current_role() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION kaizen_current_dept() FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION kaizen_current_role() TO authenticated;
GRANT  EXECUTE ON FUNCTION kaizen_current_dept() TO authenticated;

-- ============================================================
-- SECURITY TRIGGER
-- ============================================================
CREATE OR REPLACE FUNCTION kaizen_profiles_prevent_self_escalation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.role IS DISTINCT FROM OLD.role)
     OR (NEW.department IS DISTINCT FROM OLD.department)
     OR (NEW.is_active IS DISTINCT FROM OLD.is_active)
  THEN
    IF public.kaizen_current_role() <> 'super_admin' THEN
      RAISE EXCEPTION 'Only super admins can change role, department, or active status';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER kaizen_profiles_prevent_self_escalation
  BEFORE UPDATE ON kaizen_profiles
  FOR EACH ROW EXECUTE FUNCTION kaizen_profiles_prevent_self_escalation();

-- ============================================================
-- PUSH TRIGGER
-- ============================================================
CREATE OR REPLACE FUNCTION kaizen_trigger_push_notification()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'net' AS $$
BEGIN
  PERFORM net.http_post(
    url     := 'https://znxqmurhjtyfsotcorfj.supabase.co/functions/v1/kaizen-push',
    body    := to_jsonb(NEW),
    headers := '{"Content-Type": "application/json"}'::jsonb
  );
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RETURN NEW;
END;
$$;

CREATE TRIGGER on_kaizen_notification_push
  AFTER INSERT ON kaizen_notifications
  FOR EACH ROW EXECUTE FUNCTION kaizen_trigger_push_notification();

-- ============================================================
-- RLS POLICIES
-- ============================================================

CREATE POLICY "kzn_companies_select" ON kaizen_companies FOR SELECT USING (true);
CREATE POLICY "kzn_companies_insert" ON kaizen_companies FOR INSERT WITH CHECK (kaizen_current_role() = 'super_admin');
CREATE POLICY "kzn_companies_update" ON kaizen_companies FOR UPDATE USING (kaizen_current_role() = 'super_admin');

CREATE POLICY "kzn_sa_cos_select" ON kaizen_super_admin_companies
  FOR SELECT USING (super_admin_id = auth.uid() OR kaizen_current_role() = 'super_admin');
CREATE POLICY "kzn_sa_cos_insert" ON kaizen_super_admin_companies
  FOR INSERT WITH CHECK (kaizen_current_role() = 'super_admin');
CREATE POLICY "kzn_sa_cos_delete" ON kaizen_super_admin_companies
  FOR DELETE USING (kaizen_current_role() = 'super_admin');

CREATE POLICY "kzn_profiles_select"       ON kaizen_profiles FOR SELECT USING (true);
CREATE POLICY "kzn_profiles_insert_admin" ON kaizen_profiles FOR INSERT WITH CHECK (kaizen_current_role() = 'super_admin');
CREATE POLICY "kzn_profiles_update"       ON kaizen_profiles FOR UPDATE USING (id = auth.uid() OR kaizen_current_role() = 'super_admin');
CREATE POLICY "kzn_profiles_delete_admin" ON kaizen_profiles FOR DELETE USING (kaizen_current_role() = 'super_admin');

CREATE POLICY "kzn_cases_select" ON kaizen_cases FOR SELECT USING (
  kaizen_current_role() IN ('super_admin','manager')
  OR (kaizen_current_role() = 'staff' AND department = kaizen_current_dept())
);
CREATE POLICY "kzn_cases_insert" ON kaizen_cases FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);
CREATE POLICY "kzn_cases_update" ON kaizen_cases FOR UPDATE USING (
  kaizen_current_role() IN ('super_admin','manager')
  OR (kaizen_current_role() = 'staff' AND department = kaizen_current_dept())
);
CREATE POLICY "kzn_cases_delete" ON kaizen_cases FOR DELETE USING (kaizen_current_role() = 'super_admin');

CREATE POLICY "kzn_photos_select" ON kaizen_case_photos FOR SELECT USING (true);
CREATE POLICY "kzn_photos_insert" ON kaizen_case_photos FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);

CREATE POLICY "kzn_assignments_select" ON kaizen_case_assignments FOR SELECT USING (true);
CREATE POLICY "kzn_assignments_insert"  ON kaizen_case_assignments FOR INSERT WITH CHECK (kaizen_current_role() IN ('super_admin','manager'));
CREATE POLICY "kzn_assignments_update"  ON kaizen_case_assignments FOR UPDATE USING (kaizen_current_role() IN ('super_admin','manager'));

CREATE POLICY "kzn_timeline_select" ON kaizen_case_timeline FOR SELECT USING (true);
CREATE POLICY "kzn_timeline_insert" ON kaizen_case_timeline FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);

CREATE POLICY "kzn_comments_select" ON kaizen_case_comments FOR SELECT USING (true);
CREATE POLICY "kzn_comments_insert" ON kaizen_case_comments FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);
CREATE POLICY "kzn_comments_delete" ON kaizen_case_comments FOR DELETE USING (user_id = auth.uid() OR kaizen_current_role() = 'super_admin');

CREATE POLICY "kzn_notifs_select" ON kaizen_notifications FOR SELECT USING (user_id = auth.uid() OR kaizen_current_role() = 'super_admin');
CREATE POLICY "kzn_notifs_insert" ON kaizen_notifications FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);
CREATE POLICY "kzn_notifs_update" ON kaizen_notifications FOR UPDATE USING (user_id = auth.uid());

CREATE POLICY "kzn_push_select" ON kaizen_push_subscriptions FOR SELECT USING (user_id = auth.uid());
CREATE POLICY "kzn_push_insert" ON kaizen_push_subscriptions FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);
CREATE POLICY "kzn_push_update" ON kaizen_push_subscriptions FOR UPDATE USING (user_id = auth.uid());
CREATE POLICY "kzn_push_delete" ON kaizen_push_subscriptions FOR DELETE USING (user_id = auth.uid());

CREATE POLICY "kzn_settings_select" ON kaizen_settings FOR SELECT USING (true);
CREATE POLICY "kzn_settings_insert" ON kaizen_settings FOR INSERT WITH CHECK (kaizen_current_role() = 'super_admin');
CREATE POLICY "kzn_settings_update" ON kaizen_settings FOR UPDATE USING (kaizen_current_role() = 'super_admin');

-- ============================================================
-- STORAGE BUCKET
-- ============================================================
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'kaizen-photos', 'kaizen-photos', true, 10485760,
  ARRAY['image/jpeg','image/png','image/webp','image/gif']
)
ON CONFLICT (id) DO NOTHING;

CREATE POLICY "kzn_storage_upload" ON storage.objects
  FOR INSERT WITH CHECK (bucket_id = 'kaizen-photos' AND auth.uid() IS NOT NULL);
CREATE POLICY "kzn_storage_read" ON storage.objects
  FOR SELECT USING (bucket_id = 'kaizen-photos');
CREATE POLICY "kzn_storage_delete" ON storage.objects
  FOR DELETE USING (bucket_id = 'kaizen-photos' AND auth.uid() IS NOT NULL);
