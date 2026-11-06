-- Self-serve account deletion (/settings) and the email-log anonymizer it shares with retention.
-- Adds functions only: no rows change when this migration runs. Service role only.
BEGIN;

-- Strips the address and anything personal from email log rows, keeping delivery stats (type,
-- meeting, subject, status, attempt count and timestamps). Unsent mail is cancelled ('suppressed'),
-- old unsubscribe links stop working, and the de-duplication key loses its account id.
CREATE OR REPLACE FUNCTION public.anonymize_email_messages(p_ids uuid[])
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE n integer;
BEGIN
  UPDATE email_messages SET
    recipient = 'removed',
    user_id = NULL,
    payload = '{}'::jsonb,
    provider_payload = NULL,
    preview_text = NULL,
    last_error = NULL,
    unsubscribe_token = gen_random_uuid(),
    deduplication_key = 'removed/' || id,
    status = CASE WHEN status IN ('queued', 'attempting') THEN 'suppressed' ELSE status END,
    lease_token = NULL,
    lease_until = NULL,
    updated_at = now()
  WHERE id = ANY(p_ids) AND recipient <> 'removed';
  GET DIAGNOSTICS n = ROW_COUNT;
  -- Provider error text can quote the address.
  UPDATE email_events SET error_text = NULL WHERE message_id = ANY(p_ids) AND error_text IS NOT NULL;
  RETURN n;
END $$;
REVOKE ALL ON FUNCTION public.anonymize_email_messages(uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.anonymize_email_messages(uuid[]) TO service_role;

-- Everything personal about one account, before the server deletes the auth user:
-- profile (address, location, alert settings), follows and keyword alerts, API keys and
-- unsubscribe-only suppressions are deleted; email log rows are anonymized; legacy AI traces and
-- handled contact messages lose their link to the account. Bounce and spam-complaint suppressions
-- stay (keyed by address) so the site never mails a dead or complaining address again.
-- Returns counts only.
CREATE OR REPLACE FUNCTION public.delete_account_data(p_user_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  addresses text[];
  emails integer; suppressions integer; follows integer; keys integer; profiles integer;
BEGIN
  IF p_user_id IS NULL THEN RAISE EXCEPTION 'An account id is required' USING ERRCODE = '22023'; END IF;
  SELECT array_remove(array_agg(DISTINCT lower(btrim(a))), NULL) INTO addresses FROM (
    SELECT email AS a FROM auth.users WHERE id = p_user_id
    UNION ALL SELECT notification_email FROM user_profiles WHERE id = p_user_id
  ) s WHERE a IS NOT NULL AND btrim(a) <> '';

  SELECT anonymize_email_messages(coalesce(array_agg(id), '{}')) INTO emails FROM email_messages
  WHERE user_id = p_user_id OR lower(recipient) = ANY(coalesce(addresses, '{}'));
  DELETE FROM email_suppressions
  WHERE reason = 'unsubscribe' AND (user_id = p_user_id OR recipient = ANY(coalesce(addresses, '{}')));
  GET DIAGNOSTICS suppressions = ROW_COUNT;
  UPDATE email_suppressions SET user_id = NULL WHERE user_id = p_user_id;

  DELETE FROM subscriptions WHERE user_id = p_user_id;
  GET DIAGNOSTICS follows = ROW_COUNT;
  DELETE FROM api_keys WHERE user_id = p_user_id;
  GET DIAGNOSTICS keys = ROW_COUNT;
  DELETE FROM user_profiles WHERE id = p_user_id;
  GET DIAGNOSTICS profiles = ROW_COUNT;

  -- These references don't cascade and would block deleting the auth user.
  IF to_regclass('public.rag_traces') IS NOT NULL THEN
    EXECUTE 'UPDATE public.rag_traces SET user_id = NULL WHERE user_id = $1' USING p_user_id;
  END IF;
  IF to_regclass('public.rag_feedback') IS NOT NULL THEN
    EXECUTE 'UPDATE public.rag_feedback SET user_id = NULL WHERE user_id = $1' USING p_user_id;
  END IF;
  UPDATE contact_messages SET handled_by = NULL WHERE handled_by = p_user_id;

  RETURN jsonb_build_object('emails_anonymized', emails, 'suppressions_deleted', suppressions,
    'subscriptions_deleted', follows, 'api_keys_deleted', keys, 'profiles_deleted', profiles);
END $$;
REVOKE ALL ON FUNCTION public.delete_account_data(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.delete_account_data(uuid) TO service_role;

COMMIT;
