-- Residents' reports of data issues on public pages ("Report an issue"). A signed-in reader quotes what's wrong
-- and says why; an agent assesses it against the records and proposes a fix; a moderator or admin approves, edits
-- or declines. Private to the server (service role): the reporter's identity and words are never public.
CREATE TABLE IF NOT EXISTS public.data_reports (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  path text NOT NULL CHECK (path ~ '^/' AND length(path) <= 500),
  entry_key text CHECK (length(entry_key) <= 200),
  quote text CHECK (length(quote) <= 2000),
  category text NOT NULL CHECK (category IN ('wrong_fact', 'wrong_topic', 'missing', 'private', 'other')),
  note text CHECK (length(note) <= 2000),
  suggestion text CHECK (length(suggestion) <= 2000),
  source_url text CHECK (source_url IS NULL OR (source_url ~ '^https?://' AND length(source_url) <= 1000)),
  notify_reporter boolean NOT NULL DEFAULT true,
  -- new -> assessed (the agent's view is in) -> resolved (a fix was applied) | declined; duplicate when merged.
  status text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'assessed', 'resolved', 'declined', 'duplicate')),
  assessment jsonb,
  assessed_at timestamptz,
  duplicate_of bigint REFERENCES public.data_reports(id) ON DELETE SET NULL,
  resolution text CHECK (length(resolution) <= 2000),
  resolved_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  resolved_at timestamptz,
  notified_at timestamptz
);
CREATE INDEX IF NOT EXISTS data_reports_status_idx ON public.data_reports (status, created_at DESC);
CREATE INDEX IF NOT EXISTS data_reports_path_idx ON public.data_reports (path);
CREATE INDEX IF NOT EXISTS data_reports_user_idx ON public.data_reports (user_id, created_at DESC);
ALTER TABLE public.data_reports ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.data_reports FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.data_reports TO service_role;

-- The email ledger also records the note sent to a reader when their report is decided (written already sent,
-- like staff_role, so the alert dispatcher never claims it).
ALTER TABLE public.email_messages DROP CONSTRAINT IF EXISTS email_messages_message_type_check;
ALTER TABLE public.email_messages ADD CONSTRAINT email_messages_message_type_check
  CHECK (message_type = ANY (ARRAY['meeting_digest'::text, 'pre_meeting'::text, 'staff_role'::text, 'data_report'::text]));
