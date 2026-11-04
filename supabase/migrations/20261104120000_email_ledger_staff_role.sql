-- The email ledger also records the welcome email sent when someone is made a moderator or admin, so it shows in
-- /admin/emails. Those rows are written already sent ('accepted' or 'failed'); the alert dispatcher only claims
-- 'queued'/'attempting' rows, so it never sends them again.
ALTER TABLE public.email_messages DROP CONSTRAINT IF EXISTS email_messages_message_type_check;
ALTER TABLE public.email_messages ADD CONSTRAINT email_messages_message_type_check
  CHECK (message_type = ANY (ARRAY['meeting_digest'::text, 'pre_meeting'::text, 'staff_role'::text]));
