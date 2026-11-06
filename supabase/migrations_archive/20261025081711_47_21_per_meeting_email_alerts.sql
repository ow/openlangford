-- Requires 47-20. Proposed only: applying new functions/grants needs rollout approval.
BEGIN;
ALTER TABLE public.user_profiles ADD COLUMN IF NOT EXISTS email_alerts_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE public.user_profiles ADD COLUMN IF NOT EXISTS email_alerts_consent_at timestamptz;
ALTER TABLE public.user_profiles ADD COLUMN IF NOT EXISTS email_alerts_consent_version text;
-- Preserve explicitly recorded all-meeting opt-ins from the old default-off UI.
-- No consent timestamp is fabricated; cohort/version is recorded separately.
-- Weekly/unfinished/follow-only records remain off; mode and cutoff still gate all sends.
UPDATE public.user_profiles SET email_alerts_enabled=true,email_alerts_consent_version='legacy-digest-v1'
WHERE digest_enabled=true AND digest_frequency='each_meeting' AND onboarding_completed=true
AND email_alerts_consent_version IS NULL;
ALTER TABLE public.email_messages ADD COLUMN IF NOT EXISTS meeting_id bigint REFERENCES public.meetings(id) ON DELETE SET NULL;
ALTER TABLE public.email_messages ADD COLUMN IF NOT EXISTS provider_payload jsonb;
ALTER TABLE public.email_messages ADD COLUMN IF NOT EXISTS payload jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE public.email_messages ADD COLUMN IF NOT EXISTS unsubscribe_token uuid NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE public.email_messages ADD COLUMN IF NOT EXISTS consent_at timestamptz;
ALTER TABLE public.email_messages ADD COLUMN IF NOT EXISTS is_test boolean NOT NULL DEFAULT false;
ALTER TABLE public.email_messages ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE public.email_messages ADD COLUMN IF NOT EXISTS expires_at timestamptz NOT NULL DEFAULT (now() + interval '23 hours');
ALTER TABLE public.email_messages ADD COLUMN IF NOT EXISTS lease_token uuid;
ALTER TABLE public.email_messages ADD COLUMN IF NOT EXISTS lease_until timestamptz;
CREATE UNIQUE INDEX IF NOT EXISTS email_messages_unsubscribe_idx ON public.email_messages(unsubscribe_token);
CREATE INDEX IF NOT EXISTS email_messages_pending_idx ON public.email_messages(next_attempt_at, created_at) WHERE status IN ('queued','attempting');
CREATE TABLE IF NOT EXISTS public.email_suppressions (
 recipient text PRIMARY KEY CHECK (recipient=lower(btrim(recipient))),
 user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
 reason text NOT NULL CHECK (reason IN ('unsubscribe','bounced','complained','provider')),
 created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.email_suppressions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.email_suppressions FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.email_suppressions TO service_role;

-- Authenticated users can change ONLY their own consent. Legacy opt-ins are not consent.
CREATE OR REPLACE FUNCTION public.set_email_alert_consent(p_enabled boolean,p_complete_onboarding boolean DEFAULT false)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE uid uuid:=auth.uid(); address text; preserve_consent boolean;
BEGIN
 IF uid IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE='42501'; END IF;
 SELECT lower(email) INTO address FROM auth.users WHERE id=uid AND email_confirmed_at IS NOT NULL;
 IF p_enabled AND address IS NULL THEN RAISE EXCEPTION 'Confirm your sign-in email first' USING ERRCODE='22023'; END IF;
 SELECT email_alerts_enabled AND ((email_alerts_consent_version='per-meeting-v1' AND email_alerts_consent_at IS NOT NULL)
 OR (email_alerts_consent_version='legacy-digest-v1' AND digest_enabled AND onboarding_completed)) INTO preserve_consent
 FROM user_profiles WHERE id=uid FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Save a profile before email preferences' USING ERRCODE='22023'; END IF;
 UPDATE user_profiles SET email_alerts_enabled=p_enabled,onboarding_completed=onboarding_completed OR p_complete_onboarding,
  email_alerts_consent_at=CASE WHEN p_enabled AND NOT coalesce(preserve_consent,false) THEN clock_timestamp() ELSE email_alerts_consent_at END,
  email_alerts_consent_version=CASE WHEN p_enabled AND coalesce(preserve_consent,false) THEN email_alerts_consent_version WHEN p_enabled THEN 'per-meeting-v1' ELSE coalesce(email_alerts_consent_version,'declined-v1') END
 WHERE id=uid;
 IF NOT FOUND THEN RAISE EXCEPTION 'Save a profile before email preferences' USING ERRCODE='22023'; END IF;
 IF p_enabled THEN DELETE FROM email_suppressions WHERE recipient=address AND reason='unsubscribe' AND user_id=uid; END IF;
END $$;
REVOKE ALL ON FUNCTION public.set_email_alert_consent(boolean,boolean) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.set_email_alert_consent(boolean,boolean) TO authenticated;

CREATE OR REPLACE FUNCTION public.build_meeting_digest(target_meeting_id bigint)
RETURNS jsonb LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$
 SELECT jsonb_build_object('meeting',jsonb_build_object('id',m.id,'slug',m.slug,'title',m.title,'date',m.meeting_date,'summary',left(coalesce(m.summary,''),5000)),
 'decisions',coalesce((SELECT jsonb_agg(jsonb_build_object('title',x.title,'summary',x.summary,'result',x.result,'yes',x.yes_votes,'no',x.no_votes)) FROM
  (SELECT ai.title,left(coalesce(mot.plain_english_summary,mot.text_content),1500) summary,mot.result,mot.yes_votes,mot.no_votes
   FROM motions mot LEFT JOIN agenda_items ai ON ai.id=mot.agenda_item_id WHERE mot.meeting_id=m.id ORDER BY mot.id LIMIT 12) x),'[]'::jsonb))
 FROM meetings m JOIN municipalities muni ON muni.id=m.municipality_id
 WHERE m.id=target_meeting_id AND muni.slug='langford' AND (m.has_minutes OR m.has_transcript);
$$;
REVOKE ALL ON FUNCTION public.build_meeting_digest(bigint) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.build_meeting_digest(bigint) TO service_role;

-- Coordinates are current JSON lat/lng plus profile numeric fields, not old PostGIS columns.
CREATE OR REPLACE FUNCTION public.email_distance_m(lat1 double precision,lng1 double precision,location jsonb)
RETURNS double precision LANGUAGE plpgsql IMMUTABLE SET search_path=public,pg_temp AS $$
DECLARE lat2 double precision; lng2 double precision; a double precision;
BEGIN
 lat2:=(location->>'lat')::double precision; lng2:=(location->>'lng')::double precision;
 IF lat1 IS NULL OR lng1 IS NULL OR lat2 IS NULL OR lng2 IS NULL OR abs(lat1)>90 OR abs(lat2)>90 OR abs(lng1)>180 OR abs(lng2)>180 THEN RETURN NULL; END IF;
 a:=sin(radians(lat2-lat1)/2)^2+cos(radians(lat1))*cos(radians(lat2))*sin(radians(lng2-lng1)/2)^2;
 RETURN 6371000*2*asin(sqrt(least(1,greatest(0,a))));
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.email_distance_m(double precision,double precision,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.email_distance_m(double precision,double precision,jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.find_meeting_subscribers(target_meeting_id bigint)
RETURNS TABLE(user_id uuid,notification_email text,consent_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT up.id,lower(au.email),up.email_alerts_consent_at FROM user_profiles up JOIN auth.users au ON au.id=up.id
 WHERE au.email IS NOT NULL AND au.email_confirmed_at IS NOT NULL AND up.email_alerts_enabled AND ((up.email_alerts_consent_version='per-meeting-v1' AND up.email_alerts_consent_at IS NOT NULL)
 OR (up.email_alerts_consent_version='legacy-digest-v1' AND up.digest_enabled AND up.onboarding_completed)) AND up.digest_frequency='each_meeting'
 AND (nullif(btrim(up.notification_email),'') IS NULL OR lower(btrim(up.notification_email))=lower(au.email))
 AND NOT EXISTS (SELECT 1 FROM email_suppressions es WHERE es.recipient=lower(au.email))
 AND EXISTS (SELECT 1 FROM meetings m JOIN municipalities muni ON muni.id=m.municipality_id WHERE m.id=target_meeting_id AND muni.slug='langford')
 AND (up.digest_enabled OR EXISTS (
  SELECT 1 FROM subscriptions s JOIN agenda_items ai ON ai.meeting_id=target_meeting_id LEFT JOIN matters mat ON mat.id=ai.matter_id LEFT JOIN topics t ON t.id=s.topic_id
  WHERE s.user_id=up.id AND s.is_active AND (
   (s.type='matter' AND s.matter_id=ai.matter_id) OR
   (s.type='person' AND EXISTS(SELECT 1 FROM motions mot WHERE mot.meeting_id=target_meeting_id AND (mot.mover_id=s.person_id OR mot.seconder_id=s.person_id))) OR
   (s.type='topic' AND s.topic_id IS NOT NULL AND (t.name=mat.category OR t.name=ai.category)) OR
   (s.type='topic' AND s.keyword_embedding IS NOT NULL AND ai.embedding IS NOT NULL AND 1-(ai.embedding <=> s.keyword_embedding)>0.45) OR
   (s.type='neighborhood' AND ((s.neighborhood IS NOT NULL AND s.neighborhood=ai.neighborhood) OR
    email_distance_m(up.location_lat,up.location_lng,ai.geo_location)<=least(10000,greatest(100,s.proximity_radius_m))))
  )
 ));
$$;
REVOKE ALL ON FUNCTION public.find_meeting_subscribers(bigint) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.find_meeting_subscribers(bigint) TO service_role;

CREATE OR REPLACE FUNCTION public.enqueue_meeting_emails(p_meeting bigint,p_start_date date,p_test_recipient text DEFAULT NULL)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE digest jsonb; inserted integer;
BEGIN
 -- A non-null cutoff is mandatory even in test mode. Test mode can bypass date only for its exact approved recipient.
 IF p_start_date IS NULL OR NOT EXISTS(SELECT 1 FROM meetings WHERE id=p_meeting AND meeting_date<=current_date AND (p_test_recipient IS NOT NULL OR meeting_date>=p_start_date)) THEN RETURN 0; END IF;
 digest:=build_meeting_digest(p_meeting); IF digest IS NULL THEN RETURN 0; END IF;
 INSERT INTO email_messages(user_id,recipient,subject,message_type,deduplication_key,meeting_id,payload,consent_at,is_test,preview_text)
 SELECT s.user_id,s.notification_email,left((CASE WHEN p_test_recipient IS NULL THEN '' ELSE '[Test] ' END)||'Council update: '||(digest->'meeting'->>'title'),300),
  'meeting_digest','meeting/'||p_meeting||'/user/'||s.user_id||CASE WHEN p_test_recipient IS NULL THEN '/live' ELSE '/test' END,p_meeting,digest,s.consent_at,p_test_recipient IS NOT NULL,left(digest->'meeting'->>'summary',1000)
 FROM find_meeting_subscribers(p_meeting) s WHERE p_test_recipient IS NULL OR s.notification_email=lower(p_test_recipient)
 ON CONFLICT(deduplication_key) DO NOTHING;
 GET DIAGNOSTICS inserted=ROW_COUNT; RETURN inserted;
END $$;

CREATE OR REPLACE FUNCTION public.claim_email_alert(p_test_recipient text DEFAULT NULL)
RETURNS SETOF public.email_messages LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE msg email_messages%ROWTYPE;
BEGIN
 -- Expire ambiguity before provider's 24h idempotency window. Never retry an expired logical message.
 UPDATE email_messages SET status='failed',last_error='Delivery window expired',failed_at=now(),updated_at=now()
 WHERE status IN ('queued','attempting') AND (expires_at<=now() OR (attempt_count>=5 AND lease_until<=now()));
 SELECT * INTO msg FROM email_messages WHERE
  (status='queued' OR (status='attempting' AND lease_until<now())) AND next_attempt_at<=now() AND expires_at>now() AND attempt_count<5
  AND is_test=(p_test_recipient IS NOT NULL) AND (p_test_recipient IS NULL OR recipient=lower(p_test_recipient))
 ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1;
 IF NOT FOUND THEN RETURN; END IF;
 UPDATE email_messages SET status='attempting',attempt_count=attempt_count+1,lease_token=gen_random_uuid(),lease_until=now()+interval '2 minutes',updated_at=now()
 WHERE id=msg.id RETURNING * INTO msg;
 INSERT INTO email_events(message_id,event_type,attempt_number) VALUES(msg.id,'attempt_started',msg.attempt_count);
 RETURN NEXT msg;
END $$;

CREATE OR REPLACE FUNCTION public.email_alert_eligible(p_message uuid,p_start_date date)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM email_messages e JOIN find_meeting_subscribers((SELECT meeting_id FROM email_messages WHERE id=p_message)) s
 ON s.user_id=e.user_id AND s.notification_email=e.recipient AND s.consent_at IS NOT DISTINCT FROM e.consent_at
 JOIN meetings m ON m.id=e.meeting_id WHERE e.id=p_message AND e.status='attempting' AND e.expires_at>now()
 AND (m.has_minutes OR m.has_transcript) AND p_start_date IS NOT NULL AND (e.is_test OR m.meeting_date>=p_start_date));
$$;

-- Freeze the full provider request before first send so a retry across deploys is byte-stable.
CREATE OR REPLACE FUNCTION public.freeze_email_alert(p_message uuid,p_lease uuid,p_body jsonb)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=public,pg_temp AS $$
 UPDATE email_messages SET provider_payload=coalesce(provider_payload,p_body)
 WHERE id=p_message AND lease_token=p_lease AND status='attempting' RETURNING provider_payload;
$$;
REVOKE ALL ON FUNCTION public.freeze_email_alert(uuid,uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.freeze_email_alert(uuid,uuid,jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.finish_email_alert(p_message uuid,p_lease uuid,p_state text,p_provider_id text DEFAULT NULL,p_error text DEFAULT NULL,p_retry_seconds integer DEFAULT 60)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE msg email_messages%ROWTYPE; newstate text;
BEGIN
 IF p_state NOT IN ('accepted','retry','failed','suppressed') THEN RAISE EXCEPTION 'Invalid outcome'; END IF;
 SELECT * INTO msg FROM email_messages WHERE id=p_message AND lease_token=p_lease FOR UPDATE;
 IF NOT FOUND THEN RETURN false; END IF;
 newstate:=CASE WHEN msg.status IN ('suppressed','bounced','complained','delivered','accepted') THEN msg.status WHEN p_state='retry' AND msg.attempt_count<5 THEN 'queued' WHEN p_state='retry' THEN 'failed' ELSE p_state END;
 UPDATE email_messages SET status=newstate,provider_message_id=coalesce(p_provider_id,provider_message_id),last_error=CASE WHEN newstate='accepted' AND p_state IN ('retry','failed') THEN last_error ELSE left(p_error,1000) END,
 accepted_at=CASE WHEN p_state='accepted' THEN coalesce(accepted_at,now()) ELSE accepted_at END,
 failed_at=CASE WHEN newstate='failed' THEN now() ELSE failed_at END,
 next_attempt_at=now()+make_interval(secs=>least(3600,greatest(30,p_retry_seconds))),lease_until=NULL,lease_token=NULL,updated_at=now() WHERE id=msg.id;
 INSERT INTO email_events(message_id,event_type,attempt_number,provider_message_id,error_text)
 VALUES(msg.id,CASE WHEN p_state='retry' THEN 'failed' ELSE p_state END,msg.attempt_count,p_provider_id,left(p_error,1000));
 RETURN true;
END $$;

CREATE OR REPLACE FUNCTION public.unsubscribe_email_alerts(p_token uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE msg email_messages%ROWTYPE;
BEGIN
 SELECT * INTO msg FROM email_messages WHERE unsubscribe_token=p_token;
 IF NOT FOUND THEN RETURN false; END IF;
 INSERT INTO email_suppressions(recipient,user_id,reason) VALUES(msg.recipient,msg.user_id,'unsubscribe')
 ON CONFLICT(recipient) DO NOTHING;
 UPDATE user_profiles up SET email_alerts_enabled=false WHERE id=msg.user_id AND EXISTS(SELECT 1 FROM auth.users au WHERE au.id=up.id AND lower(au.email)=msg.recipient);
 UPDATE email_messages SET status='suppressed',updated_at=now(),last_error='Unsubscribed' WHERE recipient=msg.recipient AND status IN ('queued','attempting');
 RETURN true;
END $$;

CREATE OR REPLACE FUNCTION public.record_email_provider_event(p_event_id text,p_provider_id text,p_type text,p_at timestamptz,p_message uuid,p_recipient text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE msg email_messages%ROWTYPE; event_id uuid; newstate text;
BEGIN
 IF p_type NOT IN ('accepted','delivered','bounced','complained','suppressed','failed') THEN RETURN false; END IF;
 SELECT * INTO msg FROM email_messages WHERE (provider_message_id=p_provider_id OR (id=p_message AND provider_message_id IS NULL)) AND recipient=lower(p_recipient) FOR UPDATE;
 IF NOT FOUND THEN RETURN false; END IF;
 INSERT INTO email_events(message_id,event_type,provider_event_id,provider_message_id,occurred_at) VALUES(msg.id,p_type,p_event_id,p_provider_id,p_at)
 ON CONFLICT(provider_event_id) DO NOTHING RETURNING id INTO event_id;
 IF event_id IS NULL THEN RETURN false; END IF;
 newstate:=CASE WHEN p_type='complained' THEN 'complained' WHEN msg.status='complained' THEN msg.status
 WHEN p_type='bounced' THEN 'bounced' WHEN msg.status='bounced' THEN msg.status
 WHEN p_type='suppressed' THEN 'suppressed' WHEN msg.status='suppressed' THEN msg.status
 WHEN p_type='delivered' THEN 'delivered' WHEN msg.status='delivered' THEN msg.status
 WHEN p_type='accepted' AND msg.status NOT IN ('queued','attempting') THEN msg.status ELSE p_type END;
 UPDATE email_messages SET status=newstate,provider_message_id=p_provider_id,updated_at=now(),
 delivered_at=CASE WHEN p_type='delivered' THEN coalesce(delivered_at,p_at) ELSE delivered_at END,
 accepted_at=CASE WHEN p_type='accepted' THEN coalesce(accepted_at,p_at) ELSE accepted_at END,
 failed_at=CASE WHEN p_type='failed' THEN coalesce(failed_at,p_at) ELSE failed_at END WHERE id=msg.id;
 IF p_type IN ('bounced','complained','suppressed') THEN
 INSERT INTO email_suppressions(recipient,user_id,reason) VALUES(msg.recipient,msg.user_id,CASE WHEN p_type='suppressed' THEN 'provider' ELSE p_type END)
 ON CONFLICT(recipient) DO UPDATE SET reason=CASE WHEN email_suppressions.reason='complained' THEN 'complained' ELSE excluded.reason END;
 END IF;
 RETURN true;
END $$;

REVOKE ALL ON FUNCTION public.enqueue_meeting_emails(bigint,date,text),public.claim_email_alert(text),public.email_alert_eligible(uuid,date),public.finish_email_alert(uuid,uuid,text,text,text,integer),public.unsubscribe_email_alerts(uuid),public.record_email_provider_event(text,text,text,timestamptz,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.enqueue_meeting_emails(bigint,date,text),public.claim_email_alert(text),public.email_alert_eligible(uuid,date),public.finish_email_alert(uuid,uuid,text,text,text,integer),public.unsubscribe_email_alerts(uuid),public.record_email_provider_event(text,text,text,timestamptz,uuid,text) TO service_role;
COMMIT;
