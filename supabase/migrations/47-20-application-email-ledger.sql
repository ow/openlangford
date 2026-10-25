-- V1 application-alert ledger. REVIEW/APPLY SEPARATELY: no sender is connected.
-- No historical backfill, auth email content, credentials or raw provider payloads.
BEGIN;
CREATE TABLE IF NOT EXISTS public.email_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  recipient text NOT NULL CHECK (length(recipient) BETWEEN 3 AND 320),
  subject text NOT NULL CHECK (length(subject) <= 300),
  message_type text NOT NULL CHECK (message_type IN ('meeting_digest', 'pre_meeting')),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'attempting', 'accepted', 'delivered', 'failed', 'bounced', 'complained', 'suppressed')),
  deduplication_key text NOT NULL UNIQUE CHECK (length(deduplication_key) BETWEEN 1 AND 256),
  provider_message_id text UNIQUE,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  -- Dedicated plaintext excerpt only: no raw body, HTML, auth codes or token URLs.
  preview_text text CHECK (length(preview_text) <= 4000),
  last_error text CHECK (length(last_error) <= 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  accepted_at timestamptz,
  delivered_at timestamptz,
  failed_at timestamptz
);
CREATE TABLE IF NOT EXISTS public.email_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id uuid NOT NULL REFERENCES public.email_messages(id) ON DELETE CASCADE,
  event_type text NOT NULL CHECK (event_type IN ('attempt_started', 'accepted', 'delivered', 'failed', 'bounced', 'complained', 'suppressed')),
  attempt_number integer CHECK (attempt_number > 0),
  provider_event_id text UNIQUE,
  provider_message_id text,
  error_text text CHECK (length(error_text) <= 1000),
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS email_messages_created_idx ON public.email_messages (created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS email_messages_user_created_idx ON public.email_messages (user_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS email_messages_status_created_idx ON public.email_messages (status, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS email_events_message_time_idx ON public.email_events (message_id, occurred_at DESC, id DESC);
ALTER TABLE public.email_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.email_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.email_messages, public.email_events FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.email_messages TO service_role;
GRANT SELECT, INSERT, DELETE ON public.email_events TO service_role;
COMMENT ON TABLE public.email_messages IS 'V1 application-alert messages only. No sender integration or historical coverage implied.';
COMMENT ON TABLE public.email_events IS 'V1 append-only attempt/provider timeline. Delivery requires verified webhook integration.';
COMMIT;
