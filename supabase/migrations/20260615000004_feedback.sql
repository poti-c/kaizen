-- In-app feedback capture (trial feedback / "report a problem with Kaizen").
-- Any signed-in user can submit; a company's Top Management can read its own feedback.
CREATE TABLE IF NOT EXISTS kaizen_feedback (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  UUID REFERENCES kaizen_companies(id) ON DELETE SET NULL,
  user_id     UUID REFERENCES kaizen_profiles(id) ON DELETE SET NULL,
  user_name   TEXT,
  role        TEXT,
  route       TEXT,           -- the screen the user was on
  message     TEXT NOT NULL,
  user_agent  TEXT,
  lang        TEXT,
  status      TEXT NOT NULL DEFAULT 'new',  -- new | triaged | done
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE kaizen_feedback ENABLE ROW LEVEL SECURITY;

-- Anyone signed in may submit feedback (always for themselves / their company).
CREATE POLICY "kzn_feedback_insert" ON kaizen_feedback
  FOR INSERT WITH CHECK (auth.uid() IS NOT NULL AND user_id = auth.uid());

-- Top Management can read the feedback for companies they manage.
CREATE POLICY "kzn_feedback_select" ON kaizen_feedback
  FOR SELECT USING (
    kaizen_current_role() = 'super_admin'
    AND (company_id IS NULL OR company_id IN (SELECT kaizen_user_company_ids()))
  );

CREATE INDEX IF NOT EXISTS idx_kaizen_feedback_company_created
  ON kaizen_feedback (company_id, created_at DESC);
