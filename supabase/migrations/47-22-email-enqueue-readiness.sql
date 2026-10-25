-- Reviewed separately before production: replace only the existing service-only enqueue RPC.
BEGIN;
CREATE OR REPLACE FUNCTION public.enqueue_meeting_emails(p_meeting bigint,p_start_date date,p_test_recipient text DEFAULT NULL)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE digest jsonb; inserted integer;
BEGIN
 -- A non-null cutoff is mandatory even in test mode. Test mode can bypass date only for its exact approved recipient.
 IF p_start_date IS NULL OR NOT EXISTS(SELECT 1 FROM meetings WHERE id=p_meeting AND meeting_date<=current_date AND (p_test_recipient IS NOT NULL OR meeting_date>=p_start_date)) THEN RETURN 0; END IF;
 digest:=build_meeting_digest(p_meeting); IF digest IS NULL THEN RETURN 0; END IF;
 -- Retry rather than treating a missing keyword match as a successful zero.
 IF EXISTS (SELECT 1 FROM agenda_items ai WHERE ai.meeting_id=p_meeting
   AND ai.embedding IS NULL AND (
     nullif(btrim(concat_ws(' ',ai.title,ai.plain_english_summary,ai.debate_summary)),'') IS NOT NULL
     OR EXISTS (SELECT 1 FROM transcript_segments ts WHERE ts.meeting_id=ai.meeting_id
       AND (ts.agenda_item_id=ai.id OR (ts.agenda_item_id IS NULL
         AND ai.discussion_start_time IS NOT NULL AND ai.discussion_end_time IS NOT NULL
         AND ts.start_time BETWEEN ai.discussion_start_time AND ai.discussion_end_time))))) THEN
   RAISE EXCEPTION 'Email matching data not ready' USING ERRCODE='55000';
 END IF;
 INSERT INTO email_messages(user_id,recipient,subject,message_type,deduplication_key,meeting_id,payload,consent_at,is_test,preview_text)
 SELECT s.user_id,s.notification_email,left((CASE WHEN p_test_recipient IS NULL THEN '' ELSE '[Test] ' END)||'Council update: '||(digest->'meeting'->>'title'),300),
  'meeting_digest','meeting/'||p_meeting||'/user/'||s.user_id||CASE WHEN p_test_recipient IS NULL THEN '/live' ELSE '/test' END,p_meeting,digest,s.consent_at,p_test_recipient IS NOT NULL,left(digest->'meeting'->>'summary',1000)
 FROM find_meeting_subscribers(p_meeting) s WHERE p_test_recipient IS NULL OR s.notification_email=lower(p_test_recipient)
 ON CONFLICT(deduplication_key) DO NOTHING;
 GET DIAGNOSTICS inserted=ROW_COUNT; RETURN inserted;
END $$;

-- Reassert the existing service-only ACL, including on a mistakenly out-of-order apply.
REVOKE ALL ON FUNCTION public.enqueue_meeting_emails(bigint,date,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.enqueue_meeting_emails(bigint,date,text) TO service_role;
COMMIT;
