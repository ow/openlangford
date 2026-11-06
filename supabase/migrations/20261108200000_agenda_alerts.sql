-- Before-meeting agenda alerts: email subscribers when an upcoming meeting's agenda includes something they follow,
-- so they can write to council or speak while it still matters. See docs/agenda-alerts.md.
--
-- Safe on live data: one new column with a constant default (no rewrite), a wider CHECK on email_messages,
-- a new key column on email_enqueue_receipts (existing rows become kind 'digest'), new functions, and
-- find_meeting_subscribers / email_alert_eligible redefined with identical results for post-meeting digests.

-- 1. The resident's choice. People who signed up before this feature are assumed to want it (owner's decision);
--    the "Before meetings" toggle in Settings turns it off. It has no effect unless email alerts are on.
ALTER TABLE public.user_profiles ADD COLUMN IF NOT EXISTS agenda_alerts_enabled boolean NOT NULL DEFAULT true;
COMMENT ON COLUMN public.user_profiles.agenda_alerts_enabled IS
  'Email before a meeting when its agenda includes something this person follows. Needs email_alerts_enabled and consent too.';

-- 2. A new message type.
ALTER TABLE public.email_messages DROP CONSTRAINT IF EXISTS email_messages_message_type_check;
ALTER TABLE public.email_messages ADD CONSTRAINT email_messages_message_type_check
  CHECK (message_type = ANY (ARRAY['meeting_digest'::text, 'pre_meeting'::text, 'staff_role'::text, 'data_report'::text, 'agenda_preview'::text]));

-- 3. Enqueue receipts per meeting *and* kind, so the worker tracks digests and agenda previews separately.
ALTER TABLE public.email_enqueue_receipts ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'digest';
ALTER TABLE public.email_enqueue_receipts DROP CONSTRAINT IF EXISTS email_enqueue_receipts_kind_check;
ALTER TABLE public.email_enqueue_receipts ADD CONSTRAINT email_enqueue_receipts_kind_check CHECK (kind = ANY (ARRAY['digest'::text, 'agenda'::text]));
ALTER TABLE public.email_enqueue_receipts DROP CONSTRAINT IF EXISTS email_enqueue_receipts_pkey;
ALTER TABLE public.email_enqueue_receipts ADD CONSTRAINT email_enqueue_receipts_pkey PRIMARY KEY (meeting_id, kind);

-- 4. The per-item matching rule, shared by post-meeting digests and agenda previews.
--    One row per (subscription, agenda item) that matches, with which rule matched. The CASE is the former
--    OR-list from find_meeting_subscribers in the same order: a row exists exactly when some disjunct was true
--    (CASE skips NULL conditions just as WHERE does), so "EXISTS a row for this user" is the old predicate.
--    The person rule is about the whole meeting (who moved or seconded), not the item; previews ignore it.
CREATE OR REPLACE FUNCTION public.alert_subscription_matches(p_meeting bigint)
RETURNS TABLE(user_id uuid, subscription_id bigint, agenda_item_id bigint, match_type text, match_label text)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
 SELECT s.user_id, s.id, ai.id, mt.kind,
  CASE mt.kind WHEN 'matter' THEN mat.title WHEN 'topic' THEN t.name WHEN 'keyword' THEN s.keyword
   WHEN 'neighborhood' THEN s.neighborhood WHEN 'nearby' THEN up.location_label END
 FROM subscriptions s
 JOIN user_profiles up ON up.id = s.user_id
 JOIN agenda_items ai ON ai.meeting_id = p_meeting
 LEFT JOIN matters mat ON mat.id = ai.matter_id
 LEFT JOIN topics t ON t.id = s.topic_id
 CROSS JOIN LATERAL (SELECT CASE
   WHEN s.type='matter' AND s.matter_id=ai.matter_id THEN 'matter'
   WHEN s.type='person' AND EXISTS(SELECT 1 FROM motions mot WHERE mot.meeting_id=p_meeting AND (mot.mover_id=s.person_id OR mot.seconder_id=s.person_id)) THEN 'person'
   WHEN s.type='topic' AND s.topic_id IS NOT NULL AND (t.name=mat.category OR t.name=ai.category) THEN 'topic'
   WHEN s.type='topic' AND s.keyword_embedding IS NOT NULL AND ai.embedding IS NOT NULL AND 1-(ai.embedding <=> s.keyword_embedding)>0.45 THEN 'keyword'
   WHEN s.type='neighborhood' AND s.neighborhood IS NOT NULL AND s.neighborhood=ai.neighborhood THEN 'neighborhood'
   WHEN s.type='neighborhood' AND email_distance_m(up.location_lat,up.location_lng,ai.geo_location)<=least(10000,greatest(100,s.proximity_radius_m)) THEN 'nearby'
  END AS kind) mt
 WHERE s.is_active AND mt.kind IS NOT NULL;
$$;

-- Same signature, same profile rules; only the subscription match moved into alert_subscription_matches.
CREATE OR REPLACE FUNCTION public.find_meeting_subscribers(target_meeting_id bigint) RETURNS TABLE(user_id uuid, notification_email text, consent_at timestamp with time zone)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
 SELECT up.id,lower(au.email),up.email_alerts_consent_at FROM user_profiles up JOIN auth.users au ON au.id=up.id
 WHERE au.email IS NOT NULL AND au.email_confirmed_at IS NOT NULL AND up.email_alerts_enabled AND ((up.email_alerts_consent_version='per-meeting-v1' AND up.email_alerts_consent_at IS NOT NULL)
 OR (up.email_alerts_consent_version='legacy-digest-v1' AND up.digest_enabled AND up.onboarding_completed)) AND up.digest_frequency='each_meeting'
 AND (nullif(btrim(up.notification_email),'') IS NULL OR lower(btrim(up.notification_email))=lower(au.email))
 AND NOT EXISTS (SELECT 1 FROM email_suppressions es WHERE es.recipient=lower(au.email))
 AND EXISTS (SELECT 1 FROM meetings m JOIN municipalities muni ON muni.id=m.municipality_id WHERE m.id=target_meeting_id AND muni.slug='langford')
 AND (up.digest_enabled OR EXISTS (SELECT 1 FROM alert_subscription_matches(target_meeting_id) am WHERE am.user_id=up.id));
$$;

-- 5. One person's preview: the agenda items that match what they follow (all substantive items for people who
--    asked for every meeting), with the plain-English summary, whether it is a public hearing, and why it matched.
--    Procedural items (call to order, minutes, adjournment) and the generic public participation slot are left out.
CREATE OR REPLACE FUNCTION public.build_agenda_preview(p_meeting bigint, p_user uuid) RETURNS jsonb
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
 WITH mtg AS (
  SELECT m.*, muni.meta AS muni_meta FROM meetings m JOIN municipalities muni ON muni.id=m.municipality_id
  WHERE m.id=p_meeting AND muni.slug='langford'
 ), profile AS (
  SELECT coalesce(digest_enabled,false) AS every_meeting FROM user_profiles WHERE id=p_user
 ), reasons AS (
  SELECT am.agenda_item_id, jsonb_agg(DISTINCT jsonb_build_object('type',am.match_type,'label',am.match_label)) AS reasons
  FROM alert_subscription_matches(p_meeting) am WHERE am.user_id=p_user AND am.match_type<>'person'
  GROUP BY am.agenda_item_id
 ), chosen AS (
  SELECT ai.id, ai.title, ai.category, ai.slug, left(nullif(btrim(ai.plain_english_summary),''),600) AS summary,
   r.reasons,
   ((SELECT type::text FROM mtg)='Public Hearing' OR lower(coalesce(ai.category,''))='public hearing'
    OR (concat_ws(' ',ai.title,parent.title) ~* 'public hearing'
        AND concat_ws(' ',ai.title,parent.title) !~* '(prior to|before|after|following)( the)? public hearing')) AS public_hearing
  FROM agenda_items ai
  LEFT JOIN agenda_items parent ON parent.id=ai.parent_id
  LEFT JOIN reasons r ON r.agenda_item_id=ai.id
  WHERE ai.meeting_id=p_meeting AND EXISTS(SELECT 1 FROM mtg)
   AND lower(coalesce(ai.category,'')) NOT IN ('procedural','public participation')
   AND (r.reasons IS NOT NULL OR coalesce((SELECT every_meeting FROM profile),false))
  ORDER BY (r.reasons IS NULL), ai.id
  LIMIT 20
 )
 SELECT jsonb_build_object(
  'kind','agenda_preview',
  'meeting',jsonb_build_object('id',m.id,'slug',m.slug,'title',m.title,'date',m.meeting_date,'type',m.type,
   'start_time',coalesce(m.meta->'attendance_info'->>'start_time',m.meta->'calendar'->>'start_time',m.muni_meta->'attendance_info'->>'default_start_time'),
   'venue',coalesce(m.meta->'attendance_info'->>'venue',m.muni_meta->'attendance_info'->>'venue'),
   'address',coalesce(m.meta->'attendance_info'->>'address',m.muni_meta->'attendance_info'->>'address'),
   'agenda_url',m.agenda_url),
  'every_meeting',coalesce((SELECT every_meeting FROM profile),false),
  'items',coalesce((SELECT jsonb_agg(jsonb_build_object('id',c.id,'title',c.title,'summary',c.summary,'category',c.category,
     'public_hearing',c.public_hearing,'reasons',coalesce(c.reasons,'[]'::jsonb)) ORDER BY c.id) FROM chosen c),'[]'::jsonb),
  'item_ids',coalesce((SELECT jsonb_agg(c.id ORDER BY c.id) FROM chosen c),'[]'::jsonb))
 FROM mtg m;
$$;

-- 6. Queue previews for one upcoming meeting. Mirrors enqueue_meeting_emails, but the meeting must be in the
--    future, not cancelled and have an agenda, and the person must also have agenda_alerts_enabled.
--    Dedup: 'agenda/<meeting>/user/<uid>/live' is the first preview. If a later call finds items matching this
--    person that the first preview did not list (an addendum, a late item), one more preview goes out under
--    'agenda/<meeting>/user/<uid>/update/live'; any further changes are not sent. So at most two per person
--    per meeting, and removals or reworded summaries never resend.
CREATE OR REPLACE FUNCTION public.enqueue_agenda_alert_emails(p_meeting bigint, p_start_date date, p_test_recipient text DEFAULT NULL::text) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE mtg meetings%ROWTYPE; suffix text; inserted integer;
BEGIN
 IF p_start_date IS NULL THEN RETURN 0; END IF;
 SELECT m.* INTO mtg FROM meetings m JOIN municipalities muni ON muni.id=m.municipality_id
 WHERE m.id=p_meeting AND muni.slug='langford' AND m.meeting_date>current_date AND coalesce(m.has_agenda,false)
  AND lower(coalesce(m.status,''))<>'cancelled' AND (p_test_recipient IS NOT NULL OR m.meeting_date>=p_start_date);
 IF NOT FOUND THEN RETURN 0; END IF;
 -- Retry rather than treating a missing keyword match as a successful zero (no transcript exists yet).
 IF EXISTS (SELECT 1 FROM agenda_items ai WHERE ai.meeting_id=p_meeting AND ai.embedding IS NULL
   AND nullif(btrim(concat_ws(' ',ai.title,ai.plain_english_summary,ai.debate_summary)),'') IS NOT NULL) THEN
   RAISE EXCEPTION 'Email matching data not ready' USING ERRCODE='55000';
 END IF;
 suffix:=CASE WHEN p_test_recipient IS NULL THEN '/live' ELSE '/test' END;
 INSERT INTO email_messages(user_id,recipient,subject,message_type,deduplication_key,meeting_id,payload,consent_at,is_test,preview_text)
 SELECT s.user_id,s.notification_email,
  left((CASE WHEN p_test_recipient IS NULL THEN '' ELSE '[Test] ' END)||'Coming up at council: '||mtg.title||', '||to_char(mtg.meeting_date,'FMMonth FMDD'),300),
  'agenda_preview',
  'agenda/'||p_meeting||'/user/'||s.user_id||CASE WHEN first.id IS NULL THEN '' ELSE '/update' END||suffix,
  p_meeting,s.preview||jsonb_build_object('updated',first.id IS NOT NULL),s.consent_at,p_test_recipient IS NOT NULL,
  left(CASE WHEN jsonb_array_length(s.preview->'items')=1 THEN 'One item on this agenda' ELSE jsonb_array_length(s.preview->'items')||' items on this agenda' END
   ||' touch what you follow. You can write to council before the meeting.',1000)
 FROM (SELECT f.user_id,f.notification_email,f.consent_at,build_agenda_preview(p_meeting,f.user_id) AS preview
       FROM find_meeting_subscribers(p_meeting) f JOIN user_profiles up ON up.id=f.user_id
       WHERE up.agenda_alerts_enabled AND (p_test_recipient IS NULL OR f.notification_email=lower(p_test_recipient))) s
 LEFT JOIN email_messages first ON first.deduplication_key='agenda/'||p_meeting||'/user/'||s.user_id||suffix
 WHERE jsonb_array_length(coalesce(s.preview->'items','[]'::jsonb))>0
  AND (first.id IS NULL OR EXISTS (SELECT 1 FROM jsonb_array_elements(s.preview->'item_ids') x
       WHERE NOT coalesce(first.payload->'item_ids','[]'::jsonb) @> jsonb_build_array(x)))
 ON CONFLICT(deduplication_key) DO NOTHING;
 GET DIAGNOSTICS inserted=ROW_COUNT; RETURN inserted;
END $$;

-- 7. Delivery check. Post-meeting digests are unchanged (minutes or transcript required). Agenda previews need the
--    meeting still upcoming (today counts: an evening meeting is still ahead), with an agenda, not cancelled, and
--    the person still subscribed with the before-meeting toggle on.
CREATE OR REPLACE FUNCTION public.email_alert_eligible(p_message uuid, p_start_date date) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
 SELECT EXISTS(SELECT 1 FROM email_messages e JOIN find_meeting_subscribers((SELECT meeting_id FROM email_messages WHERE id=p_message)) s
 ON s.user_id=e.user_id AND s.notification_email=e.recipient AND s.consent_at IS NOT DISTINCT FROM e.consent_at
 JOIN meetings m ON m.id=e.meeting_id WHERE e.id=p_message AND e.status='attempting' AND e.expires_at>now()
 AND CASE WHEN e.message_type='agenda_preview' THEN
   m.meeting_date>=current_date AND coalesce(m.has_agenda,false) AND lower(coalesce(m.status,''))<>'cancelled'
   AND EXISTS(SELECT 1 FROM user_profiles up WHERE up.id=e.user_id AND up.agenda_alerts_enabled)
  ELSE (m.has_minutes OR m.has_transcript) END
 AND p_start_date IS NOT NULL AND (e.is_test OR m.meeting_date>=p_start_date));
$$;

-- 8. Grants: server key only, like the sibling alert functions.
REVOKE ALL ON FUNCTION public.alert_subscription_matches(bigint) FROM PUBLIC, anon, authenticated;
GRANT ALL ON FUNCTION public.alert_subscription_matches(bigint) TO service_role;
REVOKE ALL ON FUNCTION public.build_agenda_preview(bigint, uuid) FROM PUBLIC, anon, authenticated;
GRANT ALL ON FUNCTION public.build_agenda_preview(bigint, uuid) TO service_role;
REVOKE ALL ON FUNCTION public.enqueue_agenda_alert_emails(bigint, date, text) FROM PUBLIC, anon, authenticated;
GRANT ALL ON FUNCTION public.enqueue_agenda_alert_emails(bigint, date, text) TO service_role;
