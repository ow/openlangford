-- Durable per-meeting receipts for the Cloudflare Worker's email enqueue cron
-- (apps/web/workers/email-enqueue.ts). Holds meeting IDs and retry metadata only:
-- no recipients, content or credentials. Safe to apply while delivery is off:
-- it creates an empty, service-role-only table and changes no existing object.
-- The Worker tolerates this table's absence (it falls back to idempotent re-calls).
CREATE TABLE IF NOT EXISTS public.email_enqueue_receipts (
  meeting_id bigint PRIMARY KEY REFERENCES public.meetings(id) ON DELETE CASCADE,
  state text NOT NULL CHECK (state IN ('pending','done','skipped','failed','expired')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  first_attempt_at timestamptz NOT NULL DEFAULT now(),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error text CHECK (last_error IS NULL OR length(last_error) <= 200),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.email_enqueue_receipts ENABLE ROW LEVEL SECURITY;
-- No policies: only the service role (which bypasses RLS) may read or write.
REVOKE ALL ON TABLE public.email_enqueue_receipts FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.email_enqueue_receipts TO service_role;
