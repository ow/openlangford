-- Retention for personal data the site collects directly (the Worker cron runs this every 12 hours):
-- * contact messages (name, email, message, sender IP) are deleted 12 months after they arrive;
-- * email log rows lose the recipient address and anything personal 12 months after they were
--   queued (anonymize_email_messages, from the account-deletion migration); delivery stats stay.
-- AI questions have their own purge (workers/retention.ts). This migration adds a function only and
-- logs counts (never row contents); the cron does the first run. Requires 20261030200000.
BEGIN;

CREATE OR REPLACE FUNCTION public.apply_privacy_retention(p_dry_run boolean DEFAULT true)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  cutoff timestamptz := now() - interval '12 months';
  contact integer; emails integer;
BEGIN
  IF p_dry_run THEN
    SELECT count(*) INTO contact FROM contact_messages WHERE created_at < cutoff;
    SELECT count(*) INTO emails FROM email_messages WHERE created_at < cutoff AND recipient <> 'removed';
  ELSE
    DELETE FROM contact_messages WHERE created_at < cutoff;
    GET DIAGNOSTICS contact = ROW_COUNT;
    SELECT anonymize_email_messages(coalesce(array_agg(id), '{}')) INTO emails
    FROM email_messages WHERE created_at < cutoff AND recipient <> 'removed';
  END IF;
  RETURN jsonb_build_object('dry_run', p_dry_run, 'contact_messages_deleted', contact, 'email_messages_anonymized', emails);
END $$;
REVOKE ALL ON FUNCTION public.apply_privacy_retention(boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_privacy_retention(boolean) TO service_role;

DO $$
DECLARE summary jsonb := public.apply_privacy_retention(true);
BEGIN
  RAISE NOTICE 'Privacy retention dry run: %', summary;
END $$;

COMMIT;
