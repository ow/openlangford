-- Pages an admin has looked over: one row per public path, marked reviewed or needing work, with a note.
-- Private to admins for now (written and read with the service-role client); may be shown publicly later.
-- New table only: safe to apply against live data.
CREATE TABLE IF NOT EXISTS page_reviews (
  path text PRIMARY KEY CHECK (path LIKE '/%'),
  kind text NOT NULL,
  title text,
  status text NOT NULL CHECK (status IN ('reviewed', 'needs_work')),
  note text,
  reviewed_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  reviewed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS page_reviews_recent ON page_reviews (reviewed_at DESC);

ALTER TABLE page_reviews ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON page_reviews FROM anon, authenticated;
GRANT ALL ON page_reviews TO service_role;
