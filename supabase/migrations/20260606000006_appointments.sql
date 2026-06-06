-- Console calendar appointments (Setup / Troubleshooting / Meeting / Other).
CREATE TABLE IF NOT EXISTS kaizen_appointments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind          text NOT NULL DEFAULT 'setup' CHECK (kind IN ('setup','troubleshooting','meeting','other')),
  title         text NOT NULL,
  company_id    uuid REFERENCES kaizen_companies(id) ON DELETE SET NULL,
  client_name   text,
  start_at      timestamptz NOT NULL,
  end_at        timestamptz,
  all_day       boolean NOT NULL DEFAULT false,
  mode          text NOT NULL DEFAULT 'onsite' CHECK (mode IN ('onsite','remote','phone')),
  location      text,
  assignee      text,
  contact_name  text,
  contact_phone text,
  notes         text,
  status        text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','completed','cancelled')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS kaizen_appointments_start_idx ON kaizen_appointments (start_at);

-- Console reaches this table only through the service-role edge function, which
-- bypasses RLS. Enable RLS with no policies so nothing is reachable via anon/auth.
ALTER TABLE kaizen_appointments ENABLE ROW LEVEL SECURITY;
