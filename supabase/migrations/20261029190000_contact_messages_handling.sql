-- Admin handling and notification tracking for /contact submissions.
-- Safe against live data: only adds nullable columns (existing rows read as open and
-- not emailed) and an index. RLS stays on with no policies, so only the service role
-- (admin server code) can read or write; this also removes any leftover direct grants.
ALTER TABLE public.contact_messages
  ADD COLUMN IF NOT EXISTS handled_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS handled_by uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS notified_at timestamptz NULL;

CREATE INDEX IF NOT EXISTS idx_contact_messages_open
  ON public.contact_messages (created_at DESC) WHERE handled_at IS NULL;

ALTER TABLE public.contact_messages ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.contact_messages FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.contact_messages TO service_role;
