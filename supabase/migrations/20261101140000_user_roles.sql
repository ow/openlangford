-- Staff roles granted from /admin/users: moderators use most admin tools; admins also run the pipeline, manage
-- people and memberships, and grant roles. Owners in the ADMIN_EMAILS allowlist are admins without a row here.
-- New table only: safe to apply against live data.
CREATE TABLE IF NOT EXISTS user_roles (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('admin', 'moderator')),
  granted_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  granted_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE user_roles ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON user_roles FROM anon, authenticated;
GRANT ALL ON user_roles TO service_role;

-- Who did what: every change a moderator or admin makes through a staff tool (recorded by requireRole on
-- POST requests, and by the agent API). Read on /admin/users/<id>.
CREATE TABLE IF NOT EXISTS staff_actions (
  id bigserial PRIMARY KEY,
  user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  role text NOT NULL,
  path text NOT NULL,
  action text,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS staff_actions_user ON staff_actions (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS staff_actions_recent ON staff_actions (created_at DESC);

ALTER TABLE staff_actions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON staff_actions FROM anon, authenticated;
GRANT ALL ON staff_actions TO service_role;
GRANT USAGE, SELECT ON SEQUENCE staff_actions_id_seq TO service_role;
