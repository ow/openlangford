-- Baseline of the public schema, dumped (schema only) from production on 2026-11-05 with pg_dump 17
-- (production is PostgreSQL 17.6). It stands in for every migration up to and including this version;
-- the earlier files now live in supabase/migrations_archive/. See supabase/BASELINE-RUNBOOK.md.
--
-- Production already records this version in supabase_migrations.schema_migrations, so `supabase db push`
-- never re-runs it there. On an empty database it builds the whole schema.
--
-- Left out on purpose: data, ownership, the public schema itself, ALTER DEFAULT PRIVILEGES (Supabase
-- sets those), and everything Supabase manages (auth, storage, realtime, vault, extensions schema).

CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;

SET check_function_bodies = false;

--
-- PostgreSQL database dump
--

-- Dumped from database version 17.6
-- Dumped by pg_dump version 17.11

--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--

--
-- Name: SCHEMA public; Type: COMMENT; Schema: -; Owner: -
--

--
-- Name: digest_frequency; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.digest_frequency AS ENUM (
    'each_meeting',
    'weekly'
);

--
-- Name: meeting_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.meeting_type AS ENUM (
    'Regular Council',
    'Special Council',
    'Committee of the Whole',
    'Public Hearing',
    'Board of Variance',
    'Standing Committee',
    'Advisory Committee',
    'Inauguration'
);

--
-- Name: org_classification; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.org_classification AS ENUM (
    'Council',
    'Committee',
    'Board',
    'Advisory Committee',
    'Staff',
    'Other'
);

--
-- Name: subscription_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.subscription_type AS ENUM (
    'matter',
    'topic',
    'person',
    'neighborhood',
    'digest'
);

--
-- Name: _council_attendance_js_text(json); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public._council_attendance_js_text(value json) RETURNS text
    LANGUAGE plpgsql IMMUTABLE STRICT
    SET search_path TO 'public'
    AS $$
DECLARE
  pending json[] := ARRAY[value]; item json; child json;
  fragments text[] := ARRAY[]::text[]; first_child boolean;
BEGIN
  IF json_typeof(value) = 'null' THEN RETURN 'null'; END IF;
  -- Iterative Array.toString coercion avoids recursive SQL stack exhaustion.
  WHILE cardinality(pending) > 0 LOOP
    item := pending[cardinality(pending)];
    pending := pending[1:cardinality(pending)-1];
    IF item IS NULL THEN
      fragments := array_append(fragments, ','); CONTINUE;
    END IF;
    CASE json_typeof(item)
      WHEN 'string' THEN fragments := array_append(fragments, item #>> '{}');
      WHEN 'array' THEN
        first_child := true;
        FOR child IN SELECT element FROM json_array_elements(item) WITH ORDINALITY AS elements(element, ordinal) ORDER BY ordinal DESC LOOP
          IF NOT first_child THEN pending := array_append(pending, NULL::json); END IF;
          pending := array_append(pending, child); first_child := false;
        END LOOP;
      WHEN 'object' THEN fragments := array_append(fragments, '[object Object]');
      WHEN 'null' THEN NULL; -- Array.join renders null elements as empty strings.
      WHEN 'number' THEN
        BEGIN fragments := array_append(fragments, (item::text::double precision)::text);
        EXCEPTION WHEN numeric_value_out_of_range THEN fragments := array_append(fragments, 'Infinity'); END;
      ELSE fragments := array_append(fragments, item::text);
    END CASE;
  END LOOP;
  RETURN array_to_string(fragments, '');
END;
$$;

--
-- Name: _council_attendance_state(text, text, bigint, bigint, date); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public._council_attendance_state(p_notes text, p_mode text, p_meeting_id bigint, p_person_id bigint, p_date date) RETURNS TABLE(state text, verified boolean)
    LANGUAGE plpgsql IMMUTABLE
    SET search_path TO 'public'
    AS $_$
DECLARE evidence json; page double precision; valid boolean := false;
BEGIN
  state := 'unknown'; verified := false;
  BEGIN
    -- JS accepts NUL/lone-surrogate code units that PostgreSQL text cannot decode.
    -- A non-whitespace sentinel preserves the ASCII equality/prefix and quote-emptiness checks.
    evidence := regexp_replace(coalesce(nullif(p_notes, ''), 'null'),
      $rx$(?<!\\)((?:\\\\)*)\\u(0000|[dD][89a-fA-F][0-9a-fA-F]{2})$rx$, $rep$\1\\ufffd$rep$, 'g')::json;
    IF json_typeof(evidence -> 'source_page') = 'number' THEN page := (evidence ->> 'source_page')::double precision; END IF;
    valid := coalesce(
      evidence ->> 'schema' = 'council-attendance/v1'
      AND (
        (evidence ->> 'method' IN ('original_roster', 'original_minutes_attendance')
          AND public._council_attendance_js_text(evidence -> 'source_sha256') ~ '^[a-f0-9]{64}$'
          AND page >= 1 AND page < 'Infinity'::double precision AND page = trunc(page))
        -- A member saying their own name on the video (an inaugural oath, no minutes): presence only.
        OR (evidence ->> 'method' = 'video_self_identification' AND evidence ->> 'state' = 'present'
          AND json_typeof(evidence -> 'transcript_segment_id') = 'number'
          AND (evidence ->> 'transcript_segment_id')::double precision >= 1
          AND (evidence ->> 'transcript_segment_id')::double precision = trunc((evidence ->> 'transcript_segment_id')::double precision)
          AND json_typeof(evidence -> 'source_seconds') = 'number'
          AND (evidence ->> 'source_seconds')::double precision >= 0
          AND (evidence ->> 'source_seconds')::double precision < 'Infinity'::double precision
          AND (evidence ->> 'source_seconds')::double precision = trunc((evidence ->> 'source_seconds')::double precision)))
      AND evidence ->> 'state' IN ('present', 'absent')
      AND json_typeof(evidence -> 'person_id') = 'number'
      AND (evidence ->> 'person_id')::double precision = p_person_id::double precision
      AND json_typeof(evidence -> 'meeting_id') = 'number'
      AND (evidence ->> 'meeting_id')::double precision = p_meeting_id::double precision
      AND public._council_attendance_js_text(evidence -> 'source_url') ~ '^https://'
      AND json_typeof(evidence -> 'source_quote') = 'string'
      AND public._council_attendance_trim(evidence ->> 'source_quote') <> '', false);
  EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range OR untranslatable_character OR feature_not_supported THEN
    valid := false;
  END;
  IF valid THEN
    IF json_typeof(evidence -> 'local_date') = 'string' AND evidence ->> 'local_date' = to_char(p_date, 'YYYY-MM-DD') THEN
      state := evidence ->> 'state'; verified := true;
    END IF;
  ELSIF coalesce(public._council_attendance_trim(p_notes), '') = '' AND p_date BETWEEN DATE '2022-11-07' AND DATE '2026-11-01' THEN
    state := CASE WHEN p_mode = 'In Person' THEN 'present' WHEN p_mode IN ('Absent', 'Regrets') THEN 'absent' ELSE 'unknown' END;
  END IF;
  RETURN NEXT;
END;
$_$;

--
-- Name: _council_attendance_trim(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public._council_attendance_trim(value text) RETURNS text
    LANGUAGE sql IMMUTABLE STRICT
    SET search_path TO 'public'
    AS $$
  -- ECMAScript String.trim whitespace, including NBSP/BOM (not arbitrary Unicode space).
  SELECT btrim(value, E' \t\n\r\f\v' || U&'\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF');
$$;

--
-- Name: ai_usage_summary(timestamp with time zone); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ai_usage_summary(since timestamp with time zone) RETURNS TABLE(source text, stage text, calls bigint, failures bigint, input_tokens bigint, output_tokens bigint, p50_latency_ms double precision, p95_latency_ms double precision, by_model jsonb)
    LANGUAGE sql STABLE
    SET search_path TO 'public'
    AS $$
  WITH base AS (
    SELECT * FROM ai_usage WHERE created_at >= since
  ),
  per_model AS (
    SELECT b.source, b.stage, b.model, b.operation,
           count(*) AS calls,
           coalesce(sum(b.input_tokens), 0) AS input_tokens,
           coalesce(sum(b.output_tokens), 0) AS output_tokens
    FROM base b
    GROUP BY b.source, b.stage, b.model, b.operation
  )
  SELECT b.source, b.stage,
         count(*) AS calls,
         count(*) FILTER (WHERE NOT b.ok) AS failures,
         coalesce(sum(b.input_tokens), 0) AS input_tokens,
         coalesce(sum(b.output_tokens), 0) AS output_tokens,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY b.latency_ms) AS p50_latency_ms,
         percentile_cont(0.95) WITHIN GROUP (ORDER BY b.latency_ms) AS p95_latency_ms,
         (SELECT jsonb_agg(jsonb_build_object(
                    'model', pm.model, 'operation', pm.operation, 'calls', pm.calls,
                    'input_tokens', pm.input_tokens, 'output_tokens', pm.output_tokens))
            FROM per_model pm
           WHERE pm.source = b.source AND pm.stage = b.stage) AS by_model
  FROM base b
  GROUP BY b.source, b.stage
  ORDER BY count(*) DESC;
$$;

--
-- Name: anonymize_email_messages(uuid[]); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.anonymize_email_messages(p_ids uuid[]) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
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

--
-- Name: apply_calendar_sync(uuid, jsonb, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.apply_calendar_sync(p_token uuid, p_events jsonb, p_warnings jsonb DEFAULT '[]'::jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $_$
DECLARE
  muni bigint; item jsonb; source_row source_meetings%ROWTYPE; org bigint; target bigint;
  candidates bigint; match_id bigint; event_date date; today date := (now() AT TIME ZONE 'America/Vancouver')::date;
  created_count int:=0; updated_count int:=0; held_count int:=0; typ meeting_type; provenance jsonb;
BEGIN
  SELECT municipality_id INTO STRICT muni FROM calendar_sync_state
    WHERE token=p_token AND status='running' AND lease_until>now() FOR UPDATE;
  IF coalesce(jsonb_typeof(p_events),'')<>'array' OR jsonb_array_length(p_events)>64 THEN
    RAISE EXCEPTION 'Calendar batch exceeds allowed size';
  END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(p_events) LOOP
    event_date := (item->>'meeting_date')::date;
    IF coalesce(item->>'source_type','') NOT IN ('escribe','official_schedule')
       OR coalesce(length(item->>'source_id'),0) NOT BETWEEN 1 AND 150
       OR coalesce(length(item->>'title'),0) NOT BETWEEN 1 AND 150
       OR coalesce(item->>'cancelled','') NOT IN ('true','false')
       OR ((item->>'start_time') IS NOT NULL AND item->>'start_time' !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$')
       OR coalesce(item->>'type','') NOT IN ('Regular Council','Special Council','Inauguration','Committee of the Whole','Public Hearing','Advisory Committee')
       OR coalesce(item->>'organization_name','') NOT IN ('Council','Community Advisory Committee','Sustainable Development Advisory Committee','Capital West Accessibility Advisory Committee')
       OR coalesce(item->>'source_url','') NOT IN (
         'https://pub-langford.escribemeetings.com/meetingscalendarview.aspx',
         'https://langford.ca/wp-content/uploads/2025/12/2026-Council-Year-Calendar-Council-Committees.pdf')
       OR event_date IS NULL OR event_date>today+180 OR event_date<today THEN
      RAISE EXCEPTION 'Unverified or out-of-window calendar event';
    END IF;
    typ := (item->>'type')::meeting_type;
    SELECT id INTO org FROM organizations WHERE municipality_id=muni AND name=item->>'organization_name';
    IF org IS NULL THEN
      INSERT INTO organizations(name,municipality_id,classification)
        VALUES(item->>'organization_name',muni,'Committee') RETURNING id INTO org;
    END IF;
    -- Preserve documents/archive metadata and the source's existing public-record link.
    INSERT INTO source_meetings(municipality_id,source_type,source_id,meeting_date,title,meeting_type,source_url,raw,status)
      VALUES(muni,item->>'source_type',item->>'source_id',event_date,item->>'title',item->>'type',item->>'source_url',
        jsonb_build_object('calendar',item),'scheduled')
      ON CONFLICT(municipality_id,source_type,source_id) DO UPDATE SET
        last_seen_at=now(),raw=source_meetings.raw||excluded.raw,
        meeting_date=excluded.meeting_date,title=excluded.title,meeting_type=excluded.meeting_type,
        source_url=coalesce(source_meetings.source_url,excluded.source_url)
      RETURNING * INTO source_row;
    target := source_row.ingested_meeting_id;
    IF target IS NULL THEN
      SELECT id INTO target FROM meetings WHERE calendar_source_id=source_row.id;
    END IF;
    IF target IS NOT NULL AND NOT EXISTS(SELECT 1 FROM meetings WHERE id=target AND municipality_id=muni) THEN
      RAISE EXCEPTION 'Calendar source mapping crosses municipality';
    END IF;
    IF target IS NOT NULL AND item->>'source_type'='official_schedule' AND EXISTS(
       SELECT 1 FROM source_meetings WHERE ingested_meeting_id=target AND source_type='escribe') THEN
      CONTINUE; -- Published identity always outranks the annual schedule, even after rescheduling.
    END IF;
    IF target IS NULL AND item->>'source_type'='escribe' THEN
      -- Bind one future reviewed schedule entry to its published eSCRIBE identity.
      -- Multiple same-day/source events are held, never collapsed by date/type alone.
      SELECT count(*),min(m.id) INTO candidates,match_id FROM meetings m
        JOIN source_meetings s ON s.id=m.calendar_source_id
        WHERE m.municipality_id=muni AND m.organization_id=org AND m.type=typ
          AND m.meeting_date=event_date AND s.source_type='official_schedule'
          AND (m.meta->'calendar'->>'start_time' IS NULL OR item->>'start_time' IS NULL
            OR m.meta->'calendar'->>'start_time'=item->>'start_time')
          AND NOT EXISTS(SELECT 1 FROM source_meetings alias WHERE alias.ingested_meeting_id=m.id
            AND alias.source_type='escribe' AND alias.source_id<>source_row.source_id);
      IF candidates>1 OR (candidates=1 AND (SELECT count(*) FROM jsonb_array_elements(p_events) e
          WHERE e->>'source_type'='escribe' AND e->>'meeting_date'=event_date::text
          AND e->>'type'=typ::text AND e->>'organization_name'=item->>'organization_name')>1) THEN
        held_count:=held_count+1; CONTINUE;
      END IF;
      IF candidates=1 THEN target:=match_id; END IF;
      IF candidates=0 AND EXISTS(SELECT 1 FROM meetings m JOIN source_meetings s ON s.id=m.calendar_source_id
          WHERE m.municipality_id=muni AND m.organization_id=org AND m.type=typ
            AND s.source_type='official_schedule' AND abs(m.meeting_date-event_date)<=14
            AND NOT EXISTS(SELECT 1 FROM source_meetings alias WHERE alias.ingested_meeting_id=m.id AND alias.source_type='escribe')) THEN
        held_count:=held_count+1; CONTINUE; -- Possible reschedule before identity was established.
      END IF;
    END IF;
    -- Avoid creating a schedule duplicate if a public processed record already exists
    -- without a source mapping. This needs explicit reconciliation, not a blind merge.
    IF target IS NULL AND EXISTS(SELECT 1 FROM meetings m LEFT JOIN source_meetings s ON s.id=m.calendar_source_id
       WHERE m.municipality_id=muni AND m.organization_id=org AND m.meeting_date=event_date AND m.type=typ
         AND (item->>'source_type'='official_schedule' OR m.calendar_source_id IS NULL OR s.source_type='official_schedule')) THEN
      held_count:=held_count+1; CONTINUE;
    END IF;
    provenance:=jsonb_build_object('source_url',item->>'source_url','source_id',item->>'source_id',
      'source_type',item->>'source_type','verified_at',now(),'start_time',item->'start_time');
    IF target IS NULL THEN
      INSERT INTO meetings(municipality_id,organization_id,title,meeting_date,type,status,calendar_source_id,meta)
        VALUES(muni,org,item->>'title',event_date,typ,CASE WHEN (item->>'cancelled')::boolean THEN 'Cancelled' ELSE 'Planned' END,
          source_row.id,jsonb_build_object('calendar',provenance)) RETURNING id INTO target;
      created_count:=created_count+1;
    ELSE
      -- Calendar refresh cannot erase content, downgrade a completed meeting, or un-cancel one.
      UPDATE meetings SET calendar_source_id=coalesce(calendar_source_id,source_row.id),
        title=CASE WHEN archive_path IS NULL AND status='Planned' THEN item->>'title' ELSE title END,
        type=CASE WHEN archive_path IS NULL AND status='Planned' THEN typ ELSE type END,
        organization_id=CASE WHEN archive_path IS NULL AND status='Planned' THEN org ELSE organization_id END,
        meta=coalesce(meta,'{}')||jsonb_build_object('calendar',provenance),
        meeting_date=CASE WHEN archive_path IS NULL AND NOT coalesce(has_agenda,false)
          AND NOT coalesce(has_minutes,false) AND NOT coalesce(has_transcript,false) THEN event_date ELSE meeting_date END,
        status=CASE WHEN (item->>'cancelled')::boolean AND status='Planned' THEN 'Cancelled' ELSE status END
        WHERE id=target AND municipality_id=muni;
      updated_count:=updated_count+1;
    END IF;
    UPDATE source_meetings SET ingested_meeting_id=target WHERE id=source_row.id;
  END LOOP;
  provenance:=jsonb_build_object('created',created_count,'updated',updated_count,'held',held_count,'warnings',p_warnings);
  UPDATE calendar_sync_state SET status='succeeded',finished_at=now(),lease_until=NULL,result=provenance,last_error=NULL
    WHERE token=p_token;
  RETURN provenance;
END $_$;

--
-- Name: apply_log_retention(integer, integer, boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.apply_log_retention(p_keep_days integer DEFAULT 90, p_batch integer DEFAULT 50000, p_dry_run boolean DEFAULT false) RETURNS jsonb
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
DECLARE
  -- Whole UTC days only, so a rolled-up day is never split between raw rows and the summary.
  v_cutoff timestamptz := date_trunc('day', now(), 'UTC') - make_interval(days => greatest(p_keep_days, 30));
  v_usage bigint;
  v_events bigint;
BEGIN
  IF p_dry_run THEN
    SELECT count(*) INTO v_usage FROM ai_usage WHERE created_at < v_cutoff;
    SELECT count(*) INTO v_events FROM pipeline_run_events WHERE created_at < v_cutoff;
    RETURN jsonb_build_object('dry_run', true, 'cutoff', v_cutoff, 'ai_usage_due', v_usage, 'run_events_due', v_events);
  END IF;

  WITH moved AS (
    DELETE FROM ai_usage WHERE id IN (
      SELECT id FROM ai_usage WHERE created_at < v_cutoff ORDER BY created_at LIMIT p_batch)
    RETURNING created_at, source, stage, operation, model, ok, input_tokens, output_tokens, latency_ms
  ), daily AS (
    INSERT INTO ai_usage_daily AS d (day, source, stage, operation, model, calls, failures, input_tokens, output_tokens, latency_ms)
    SELECT (created_at AT TIME ZONE 'UTC')::date, coalesce(source, ''), coalesce(stage, ''), coalesce(operation, ''), coalesce(model, ''),
           count(*), count(*) FILTER (WHERE NOT ok), coalesce(sum(input_tokens), 0), coalesce(sum(output_tokens), 0), coalesce(sum(latency_ms), 0)
      FROM moved GROUP BY 1, 2, 3, 4, 5
    ON CONFLICT (day, source, stage, operation, model) DO UPDATE SET
      calls = d.calls + excluded.calls, failures = d.failures + excluded.failures,
      input_tokens = d.input_tokens + excluded.input_tokens, output_tokens = d.output_tokens + excluded.output_tokens,
      latency_ms = d.latency_ms + excluded.latency_ms
    RETURNING 1
  )
  SELECT count(*) INTO v_usage FROM moved;

  DELETE FROM pipeline_run_events WHERE id IN (
    SELECT id FROM pipeline_run_events WHERE created_at < v_cutoff ORDER BY created_at LIMIT p_batch);
  GET DIAGNOSTICS v_events = ROW_COUNT;

  RETURN jsonb_build_object('dry_run', false, 'cutoff', v_cutoff, 'ai_usage_rolled_up', v_usage, 'run_events_deleted', v_events);
END $$;

--
-- Name: apply_privacy_retention(boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.apply_privacy_retention(p_dry_run boolean DEFAULT true) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
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

--
-- Name: apply_public_participation_summary(integer, jsonb, jsonb, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.apply_public_participation_summary(p_item_id integer, p_expected_item jsonb, p_expected_segments jsonb, p_after_meta jsonb) RETURNS boolean
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public'
    AS $$
DECLARE actual jsonb; sources jsonb; item public.agenda_items%ROWTYPE;
BEGIN
 -- A brief SHARE lock closes insert/delete phantoms inside the source window.
 LOCK TABLE public.transcript_segments IN SHARE MODE;
 SELECT * INTO item FROM public.agenda_items WHERE id=p_item_id FOR UPDATE;
 IF NOT FOUND THEN RETURN false; END IF;
 actual := jsonb_build_object('id',item.id,'meeting_id',item.meeting_id,'title',item.title,
   'meta',item.meta,'discussion_start_time',item.discussion_start_time,'discussion_end_time',item.discussion_end_time);
 IF actual IS DISTINCT FROM p_expected_item THEN RETURN false; END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',s.id,'meeting_id',s.meeting_id,'start_time',s.start_time,
   'end_time',s.end_time,'speaker_name',s.speaker_name,'text_content',s.text_content) ORDER BY s.start_time,s.id),'[]'::jsonb)
 INTO sources FROM public.transcript_segments s WHERE s.meeting_id=item.meeting_id
   AND s.start_time<item.discussion_end_time AND s.end_time>item.discussion_start_time;
 IF sources IS DISTINCT FROM p_expected_segments THEN RETURN false; END IF;
 IF jsonb_typeof(p_after_meta) IS DISTINCT FROM 'object' OR
    (coalesce(item.meta,'{}'::jsonb)-'participation'-'participation_version'-'participation_review_hold') IS DISTINCT FROM
    (p_after_meta-'participation'-'participation_version'-'participation_review_hold') THEN
   RAISE EXCEPTION 'Unrelated agenda metadata must be preserved';
 END IF;
 UPDATE public.agenda_items SET meta=p_after_meta WHERE id=p_item_id;
 RETURN true;
END $$;

--
-- Name: apply_transcript_identity_evidence(bigint, jsonb, bigint, text, text, text, text, jsonb, jsonb, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.apply_transcript_identity_evidence(p_segment_id bigint, p_expected jsonb, p_person_id bigint, p_speaker_name text, p_validator_version text, p_validator_sha256 text, p_input_sha256 text, p_source_run jsonb, p_evidence jsonb, p_input_canonical_json text) RETURNS jsonb
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public'
    AS $$
DECLARE
    v_before public.transcript_segments%ROWTYPE;
    v_expected public.transcript_segments%ROWTYPE;
    v_after public.transcript_segments%ROWTYPE;
    v_existing public.transcript_identity_evidence%ROWTYPE;
    v_canonical_name text;
    v_input jsonb;
    v_envelope jsonb := '{}'::jsonb;
    v_key text;
    v_identity_sha text;
    v_id uuid;
BEGIN
    SELECT * INTO v_before FROM public.transcript_segments WHERE id=p_segment_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'transcript segment unavailable'; END IF;
    IF jsonb_typeof(p_expected) IS DISTINCT FROM 'object'
        OR EXISTS(SELECT 1 FROM jsonb_object_keys(to_jsonb(v_before)) AS k(name) WHERE NOT (p_expected ? k.name))
        OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_expected) AS k(name) WHERE NOT (to_jsonb(v_before) ? k.name)) THEN
        RAISE EXCEPTION 'complete before-row required';
    END IF;
    SELECT * INTO v_expected FROM jsonb_populate_record(NULL::public.transcript_segments,p_expected);
    SELECT name INTO v_canonical_name FROM public.people WHERE id=p_person_id FOR SHARE;
    IF NOT FOUND OR p_speaker_name IS DISTINCT FROM v_canonical_name THEN
        RAISE EXCEPTION 'canonical person and exact canonical name required';
    END IF;
    IF p_evidence #>> '{link,status}' IS DISTINCT FROM 'link_candidate'
        OR (p_evidence #>> '{link,person_id}')::bigint IS DISTINCT FROM p_person_id
        OR (p_evidence #>> '{link,segment_id}')::bigint IS DISTINCT FROM p_segment_id
        OR p_evidence #>> '{admission,status}' IS DISTINCT FROM 'identity_admitted'
        OR (p_evidence #>> '{admission,person_id}')::bigint IS DISTINCT FROM p_person_id
        OR p_evidence #>> '{link,speaker_name}' IS DISTINCT FROM p_speaker_name THEN
        RAISE EXCEPTION 'machine admission and exact link candidate required';
    END IF;
    FOREACH v_key IN ARRAY ARRAY['meeting_id','recording_id','recording_sha256','transcript_sha256','diarization_run_sha256','validator_version','validator_sha256','identity_evidence_sha256'] LOOP
        IF coalesce(p_evidence->'link'->>v_key,'')=''
            OR p_evidence->'link'->v_key IS DISTINCT FROM p_evidence->'admission'->v_key THEN
            RAISE EXCEPTION 'identity/link envelope mismatch: %',v_key;
        END IF;
        v_envelope := v_envelope || jsonb_build_object(v_key,p_evidence->'link'->v_key);
    END LOOP;
    FOREACH v_key IN ARRAY ARRAY['meeting_id','recording_id','recording_sha256','transcript_sha256','diarization_run_sha256'] LOOP
        IF p_evidence->'link'->v_key IS DISTINCT FROM p_source_run->v_key THEN
            RAISE EXCEPTION 'source run mismatch: %',v_key;
        END IF;
    END LOOP;
    IF (p_source_run->>'meeting_id')::bigint IS DISTINCT FROM v_before.meeting_id
        OR p_evidence #>> '{link,validator_version}' IS DISTINCT FROM p_validator_version
        OR p_evidence #>> '{link,validator_sha256}' IS DISTINCT FROM p_validator_sha256 THEN
        RAISE EXCEPTION 'meeting or validator version mismatch';
    END IF;
    v_identity_sha := p_evidence #>> '{link,identity_evidence_sha256}';
    v_input := p_input_canonical_json::jsonb;
    IF p_input_sha256 IS DISTINCT FROM encode(sha256(convert_to(p_input_canonical_json,'UTF8')),'hex')
        OR p_evidence #>> '{link,input_sha256}' IS DISTINCT FROM p_input_sha256
        OR p_evidence #>> '{link,input_canonical_json}' IS DISTINCT FROM p_input_canonical_json
        OR p_evidence->'link'->'expected_row' IS DISTINCT FROM p_expected
        OR v_input IS DISTINCT FROM jsonb_build_object(
            'source_run',p_source_run,'envelope',v_envelope,'expected_row',p_expected,
            'person_id',p_person_id,'speaker_name',p_speaker_name,
            'operation',p_evidence->'link'->'operation','evidence',p_evidence->'link'->'evidence') THEN
        RAISE EXCEPTION 'candidate whole-input fingerprint mismatch';
    END IF;
    SELECT * INTO v_existing FROM public.transcript_identity_evidence
        WHERE segment_id=p_segment_id AND input_sha256=p_input_sha256;
    IF FOUND THEN
        IF v_existing.status='applied' AND to_jsonb(v_before)=v_existing.after_row
            AND v_existing.before_row=to_jsonb(v_expected) AND v_existing.person_id=p_person_id
            AND v_existing.validator_version=p_validator_version AND v_existing.validator_sha256=p_validator_sha256
            AND v_existing.source_run=p_source_run AND v_existing.evidence=p_evidence
            AND v_existing.after_row->>'speaker_name'=p_speaker_name THEN
            RETURN jsonb_build_object('status','already_applied','evidence_id',v_existing.id,'segment_id',p_segment_id);
        END IF;
        RAISE EXCEPTION 'identity receipt exists but current row or request differs';
    END IF;
    IF to_jsonb(v_before) IS DISTINCT FROM to_jsonb(v_expected) THEN
        RAISE EXCEPTION USING ERRCODE='40001', MESSAGE='transcript identity compare-and-swap failed';
    END IF;
    IF v_before.is_verified IS TRUE THEN RAISE EXCEPTION 'protected verified transcript row'; END IF;
    IF v_before.person_id IS NOT NULL AND v_before.person_id IS DISTINCT FROM p_person_id THEN
        RAISE EXCEPTION 'existing different identity requires separate source-reviewed correction';
    END IF;
    IF (v_before.person_id IS NULL AND p_evidence #>> '{link,operation}' IS DISTINCT FROM 'fill_null')
        OR (v_before.person_id IS NOT NULL AND p_evidence #>> '{link,operation}' IS DISTINCT FROM 'retain_supported') THEN
        RAISE EXCEPTION 'identity operation does not match current row';
    END IF;
    -- Re-preparing the same source proof against its already-applied after-row
    -- is a no-op, not an unbounded new receipt/timestamp on every worker run.
    SELECT * INTO v_existing FROM public.transcript_identity_evidence
        WHERE segment_id=p_segment_id AND validator_sha256=p_validator_sha256
        AND identity_evidence_sha256=v_identity_sha AND source_run=p_source_run;
    IF FOUND THEN
        IF v_existing.status='applied' AND to_jsonb(v_before)=v_existing.after_row
            AND v_existing.person_id=p_person_id AND v_existing.after_row->>'speaker_name'=p_speaker_name THEN
            RETURN jsonb_build_object('status','already_applied','evidence_id',v_existing.id,'segment_id',p_segment_id);
        END IF;
        RAISE EXCEPTION 'source identity scope already has a different or reverted receipt';
    END IF;
    UPDATE public.transcript_segments SET person_id=p_person_id,speaker_name=p_speaker_name,
        attribution_source='SOURCE_VALIDATED_DIARIZATION'
        WHERE id=p_segment_id RETURNING * INTO v_after;
    INSERT INTO public.transcript_identity_evidence (
        segment_id,meeting_id,person_id,validator_version,validator_sha256,identity_evidence_sha256,input_sha256,
        source_run,evidence,before_row,after_row
    ) VALUES (
        p_segment_id,v_before.meeting_id,p_person_id,p_validator_version,p_validator_sha256,v_identity_sha,p_input_sha256,
        p_source_run,p_evidence,to_jsonb(v_before),to_jsonb(v_after)
    ) RETURNING id INTO v_id;
    RETURN jsonb_build_object('status','applied','evidence_id',v_id,'segment_id',p_segment_id);
END;
$$;

--
-- Name: build_meeting_digest(bigint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.build_meeting_digest(target_meeting_id bigint) RETURNS jsonb
    LANGUAGE sql STABLE
    SET search_path TO 'public', 'pg_temp'
    AS $$
 SELECT jsonb_build_object('meeting',jsonb_build_object('id',m.id,'slug',m.slug,'title',m.title,'date',m.meeting_date,'summary',left(coalesce(m.summary,''),5000)),
 'decisions',coalesce((SELECT jsonb_agg(jsonb_build_object('title',x.title,'summary',x.summary,'result',x.result,'yes',x.yes_votes,'no',x.no_votes)) FROM
  (SELECT ai.title,left(coalesce(mot.plain_english_summary,mot.text_content),1500) summary,mot.result,mot.yes_votes,mot.no_votes
   FROM motions mot LEFT JOIN agenda_items ai ON ai.id=mot.agenda_item_id WHERE mot.meeting_id=m.id ORDER BY mot.id LIMIT 12) x),'[]'::jsonb))
 FROM meetings m JOIN municipalities muni ON muni.id=m.municipality_id
 WHERE m.id=target_meeting_id AND muni.slug='langford' AND (m.has_minutes OR m.has_transcript);
$$;

--
-- Name: bulk_classify_topics_by_category(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.bulk_classify_topics_by_category() RETURNS integer
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
DECLARE
  row_count integer;
BEGIN
  INSERT INTO agenda_item_topics (agenda_item_id, topic_id)
  SELECT ai.id, t.id
  FROM agenda_items ai
  JOIN topics t ON t.name = normalize_category_to_topic(ai.category)
  WHERE NOT EXISTS (
    SELECT 1 FROM agenda_item_topics ait WHERE ait.agenda_item_id = ai.id
  )
  ON CONFLICT DO NOTHING;

  GET DIAGNOSTICS row_count = ROW_COUNT;
  RETURN row_count;
END;
$$;

--
-- Name: bylaw_slug_base(text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.bylaw_slug_base(bylaw_number text, title text) RETURNS text
    LANGUAGE plpgsql IMMUTABLE
    AS $_$
DECLARE
  base text;
BEGIN
  IF nullif(trim(bylaw_number), '') IS NOT NULL THEN
    base := public.generate_slug_capped('bylaw ' || regexp_replace(bylaw_number, '^\s*bylaw\s*(no\.?)?\s*', '', 'i'), 60);
  ELSE
    base := public.generate_slug_capped(COALESCE(title, 'bylaw'), 60);
  END IF;
  IF base IS NULL OR base = '' THEN base := 'bylaw'; END IF;
  IF base ~ '^[0-9]+$' THEN base := 'bylaw-' || base; END IF;
  RETURN base;
END;
$_$;

--
-- Name: claim_calendar_sync(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.claim_calendar_sync(p_trigger text DEFAULT 'manual'::text) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE run uuid := gen_random_uuid(); muni bigint;
BEGIN
  IF p_trigger NOT IN ('manual','cron') THEN RAISE EXCEPTION 'Unknown calendar trigger'; END IF;
  SELECT id INTO STRICT muni FROM municipalities WHERE slug='langford';
  INSERT INTO calendar_sync_state(municipality_id,token,lease_until,started_at,status,last_trigger)
    VALUES(muni,run,now()+interval '5 minutes',now(),'running',p_trigger)
    ON CONFLICT(municipality_id) DO UPDATE SET token=excluded.token,
      lease_until=excluded.lease_until,started_at=excluded.started_at,finished_at=NULL,
      last_trigger=excluded.last_trigger,status='running',last_error=NULL
    WHERE calendar_sync_state.lease_until IS NULL OR calendar_sync_state.lease_until<now();
  IF NOT FOUND THEN RETURN NULL; END IF;
  RETURN run;
END $$;

--
-- Name: email_messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.email_messages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid,
    recipient text NOT NULL,
    subject text NOT NULL,
    message_type text NOT NULL,
    status text DEFAULT 'queued'::text NOT NULL,
    deduplication_key text NOT NULL,
    provider_message_id text,
    attempt_count integer DEFAULT 0 NOT NULL,
    preview_text text,
    last_error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    accepted_at timestamp with time zone,
    delivered_at timestamp with time zone,
    failed_at timestamp with time zone,
    meeting_id bigint,
    provider_payload jsonb,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    unsubscribe_token uuid DEFAULT gen_random_uuid() NOT NULL,
    consent_at timestamp with time zone,
    is_test boolean DEFAULT false NOT NULL,
    next_attempt_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone DEFAULT (now() + '23:00:00'::interval) NOT NULL,
    lease_token uuid,
    lease_until timestamp with time zone,
    CONSTRAINT email_messages_attempt_count_check CHECK ((attempt_count >= 0)),
    CONSTRAINT email_messages_deduplication_key_check CHECK (((length(deduplication_key) >= 1) AND (length(deduplication_key) <= 256))),
    CONSTRAINT email_messages_last_error_check CHECK ((length(last_error) <= 1000)),
    CONSTRAINT email_messages_message_type_check CHECK ((message_type = ANY (ARRAY['meeting_digest'::text, 'pre_meeting'::text, 'staff_role'::text, 'data_report'::text]))),
    CONSTRAINT email_messages_preview_text_check CHECK ((length(preview_text) <= 4000)),
    CONSTRAINT email_messages_recipient_check CHECK (((length(recipient) >= 3) AND (length(recipient) <= 320))),
    CONSTRAINT email_messages_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'attempting'::text, 'accepted'::text, 'delivered'::text, 'failed'::text, 'bounced'::text, 'complained'::text, 'suppressed'::text]))),
    CONSTRAINT email_messages_subject_check CHECK ((length(subject) <= 300))
);

--
-- Name: TABLE email_messages; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.email_messages IS 'V1 application-alert messages only. No sender integration or historical coverage implied.';

--
-- Name: claim_email_alert(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.claim_email_alert(p_test_recipient text DEFAULT NULL::text) RETURNS SETOF public.email_messages
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
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

--
-- Name: pipeline_jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pipeline_jobs (
    id bigint NOT NULL,
    municipality_id bigint NOT NULL,
    job_type text NOT NULL,
    status text DEFAULT 'queued'::text NOT NULL,
    args jsonb DEFAULT '{}'::jsonb NOT NULL,
    priority integer DEFAULT 0 NOT NULL,
    requested_by text,
    requested_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL,
    started_at timestamp with time zone,
    finished_at timestamp with time zone,
    locked_by text,
    locked_at timestamp with time zone,
    attempt_count integer DEFAULT 0 NOT NULL,
    max_attempts integer DEFAULT 1 NOT NULL,
    last_error text,
    result jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL,
    updated_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL,
    CONSTRAINT pipeline_jobs_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'running'::text, 'succeeded'::text, 'failed'::text, 'cancelled'::text])))
);

--
-- Name: claim_next_pipeline_job(text, text[]); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.claim_next_pipeline_job(worker_id text, job_types text[] DEFAULT NULL::text[]) RETURNS SETOF public.pipeline_jobs
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
    RETURN QUERY
    WITH next_job AS (
        SELECT pj.id
        FROM pipeline_jobs pj
        WHERE pj.status = 'queued'
          AND pj.attempt_count < pj.max_attempts
          AND (job_types IS NULL OR pj.job_type = ANY(job_types))
          AND (
              NOT (pj.args ? 'source_meeting_id')
              OR pg_try_advisory_xact_lock(
                  pj.municipality_id::integer,
                  hashtext(pj.args->>'source_meeting_id')
              )
          )
          AND NOT EXISTS (
              SELECT 1
              FROM pipeline_jobs running
              WHERE running.status = 'running'
                AND running.id <> pj.id
                AND running.municipality_id = pj.municipality_id
                AND running.args ? 'source_meeting_id'
                AND pj.args ? 'source_meeting_id'
                AND running.args->>'source_meeting_id' = pj.args->>'source_meeting_id'
          )
        ORDER BY pj.priority DESC, pj.requested_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
    )
    UPDATE pipeline_jobs
    SET status = 'running',
        locked_by = worker_id,
        locked_at = timezone('utc'::text, now()),
        started_at = COALESCE(started_at, timezone('utc'::text, now())),
        attempt_count = attempt_count + 1,
        last_error = NULL
    WHERE id IN (SELECT id FROM next_job)
    RETURNING pipeline_jobs.*;
END;
$$;

--
-- Name: council_attendance_summaries(bigint, date); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.council_attendance_summaries(p_municipality_id bigint, p_as_of date DEFAULT ((CURRENT_TIMESTAMP AT TIME ZONE 'America/Vancouver'::text))::date) RETURNS TABLE(person_id bigint, term_key text, total integer, attended integer, absent integer, unknown integer, verified integer, recorded integer, rate integer)
    LANGUAGE plpgsql STABLE
    SET search_path TO 'public'
    AS $$
DECLARE council_id bigint;
BEGIN
  IF p_municipality_id IS NULL OR p_as_of IS NULL THEN RAISE EXCEPTION 'Municipality and as-of date required'; END IF;
  SELECT o.id INTO STRICT council_id FROM public.organizations o
    WHERE o.municipality_id = p_municipality_id AND o.classification = 'Council';
  RETURN QUERY
  WITH council_people AS (
    SELECT DISTINCT m.person_id FROM public.memberships m WHERE m.organization_id = council_id
  ), periods AS (
    SELECT t.id::text AS term_key, t.start_date, least(coalesce(t.end_date, p_as_of), p_as_of) AS end_date
      FROM public.council_terms t WHERE t.municipality_id = p_municipality_id
    UNION ALL SELECT 'all', DATE '0001-01-01', p_as_of
  ), expected AS (
    SELECT p.person_id, mt.id AS meeting_id, mt.meeting_date
    FROM council_people p CROSS JOIN public.meetings mt
    WHERE mt.organization_id = council_id AND mt.meeting_date <= p_as_of
      AND lower(coalesce(mt.status::text, '')) NOT IN ('cancelled', 'canceled')
      AND (mt.has_agenda IS TRUE OR mt.has_minutes IS TRUE OR mt.has_transcript IS TRUE OR mt.summary IS NOT NULL)
      AND EXISTS (SELECT 1 FROM public.memberships ms WHERE ms.person_id = p.person_id AND ms.organization_id = council_id
        AND (ms.start_date IS NULL OR ms.start_date <= mt.meeting_date)
        AND (ms.end_date IS NULL OR ms.end_date >= mt.meeting_date))
  ), per_meeting AS (
    SELECT e.person_id, e.meeting_id, e.meeting_date,
      CASE WHEN count(DISTINCT s.state) = 1 THEN min(s.state) ELSE 'unknown' END AS state,
      bool_or(s.verified) AS source_verified
    FROM expected e LEFT JOIN public.attendance a ON a.meeting_id = e.meeting_id AND a.person_id = e.person_id
    CROSS JOIN LATERAL public._council_attendance_state(a.notes, a.attendance_mode, e.meeting_id, e.person_id, e.meeting_date) s
    GROUP BY e.person_id, e.meeting_id, e.meeting_date
  ), counts AS (
    SELECT p.person_id, term.term_key, count(m.meeting_id)::integer AS total,
      count(*) FILTER (WHERE m.state = 'present')::integer AS attended,
      count(*) FILTER (WHERE m.state = 'absent')::integer AS absent,
      count(*) FILTER (WHERE m.state IN ('present', 'absent') AND m.source_verified)::integer AS verified
    FROM council_people p CROSS JOIN periods term
    LEFT JOIN per_meeting m ON m.person_id = p.person_id AND m.meeting_date BETWEEN term.start_date AND term.end_date
    GROUP BY p.person_id, term.term_key
  )
  SELECT c.person_id, c.term_key, c.total, c.attended, c.absent,
    c.total - c.attended - c.absent, c.verified, c.attended + c.absent,
    CASE WHEN c.total > 0 AND (c.total = c.attended + c.absent OR c.attended + c.absent > c.verified)
      THEN round(c.attended::numeric * 100 / c.total)::integer ELSE NULL END
  FROM counts c ORDER BY c.person_id, c.term_key;
END;
$$;

--
-- Name: council_term_stats(bigint, date); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.council_term_stats(p_municipality_id bigint, p_as_of date) RETURNS TABLE(term_id bigint, meetings integer, regular_council integer, special_council integer, committee_of_the_whole integer, committees integer, motions_carried integer, motions_defeated integer, bylaws_adopted integer, bylaw_adoption_dates jsonb, motions_by_month jsonb, meetings_by_month jsonb, spoken_comments integer, letters integer, public_supports integer, public_opposes integer, public_topics jsonb, topics jsonb)
    LANGUAGE sql STABLE
    SET search_path TO 'public'
    AS $$
  WITH term AS (
    SELECT t.id, t.start_date, LEAST(COALESCE(t.end_date, p_as_of), p_as_of) AS end_date
    FROM council_terms t
    WHERE t.municipality_id = p_municipality_id AND t.start_date <= p_as_of
  ),
  held AS (
    SELECT term.id AS term_id, m.id, m.meeting_date, m.type::text AS type, o.classification::text AS classification
    FROM term
    JOIN meetings m ON m.municipality_id = p_municipality_id
      AND m.meeting_date BETWEEN term.start_date AND term.end_date
      AND COALESCE(m.status, '') !~* 'cancel'
    LEFT JOIN organizations o ON o.id = m.organization_id
  ),
  decided AS (
    SELECT held.term_id, held.meeting_date, mo.result, mo.text_content, held.classification, a.title AS item_title
    FROM held
    JOIN motions mo ON mo.meeting_id = held.id
    LEFT JOIN agenda_items a ON a.id = mo.agenda_item_id
    WHERE mo.result ~* '^\s*(carried|defeated)'
  ),
  -- Council's own adoption motions, not recommendations or directions to prepare a bylaw. The bylaw is the last
  -- "Bylaw No. N" in the motion ("Building Bylaw No. 1160, Amendment No. 18 ... Bylaw No. 2283" is 2283).
  adoption AS (
    SELECT d.term_id, d.meeting_date, (
      SELECT x[1] FROM regexp_matches(d.text_content, 'Bylaw\s+No\.?\s*(\d{3,5})', 'gi') WITH ORDINALITY AS r(x, n)
      ORDER BY n DESC LIMIT 1
    ) AS bylaw
    FROM decided d
    WHERE d.classification = 'Council' AND d.result ~* '^\s*carried'
      AND d.text_content ~* '\madopt' AND d.text_content ~* 'bylaw'
      AND d.text_content !~* 'recommend|direct(s|ed)?\s+staff|\mprepare|\mrefer'
  ),
  -- One date per bylaw: the first adoption in the term.
  adopted AS (
    SELECT term_id, bylaw, MIN(meeting_date) AS adopted_on FROM adoption WHERE bylaw IS NOT NULL GROUP BY term_id, bylaw
  ),
  items AS (
    SELECT held.term_id, a.matter_id, a.meta FROM held JOIN agenda_items a ON a.meeting_id = held.id
  ),
  -- Residents' comments at the meeting (agenda_items.meta.participation) and letters in the agenda package
  -- (meta.written_participation), as the pipeline recorded them.
  said AS (
    SELECT i.term_id, s.value AS speaker, s.ordinality - 1 AS idx, i.matter_id, i.meta->'participation'->'about_matters' AS about
    FROM items i, jsonb_array_elements(i.meta->'participation'->'speakers') WITH ORDINALITY AS s
    WHERE jsonb_typeof(i.meta->'participation'->'speakers') = 'array'
  ),
  written AS (
    SELECT i.term_id, l.value AS letter, i.matter_id
    FROM items i,
      jsonb_array_elements(CASE WHEN jsonb_typeof(i.meta->'written_participation'->'documents') = 'array'
        THEN i.meta->'written_participation'->'documents' ELSE '[]'::jsonb END) d,
      jsonb_array_elements(CASE WHEN jsonb_typeof(d->'letters') = 'array' THEN d->'letters' ELSE '[]'::jsonb END) l
  ),
  -- A comment counts toward each topic it was about: the topics the pipeline tied it to on a general public
  -- participation item, otherwise the item's own topic. A letter counts toward its item's topic.
  input_topics AS (
    SELECT s.term_id, am.key::bigint AS matter_id
    FROM said s, jsonb_each(s.about) am
    WHERE jsonb_typeof(s.about) = 'object' AND jsonb_typeof(am.value) = 'array' AND am.value @> to_jsonb(s.idx)
    UNION ALL
    SELECT s.term_id, s.matter_id FROM said s WHERE s.matter_id IS NOT NULL AND jsonb_typeof(s.about) IS DISTINCT FROM 'object'
    UNION ALL
    SELECT w.term_id, w.matter_id FROM written w WHERE w.matter_id IS NOT NULL
  ),
  -- Topics with the same public title (a bylaw's several rounds) are listed once, linked to the busiest.
  public_topic_counts AS (
    SELECT term_id, title, (ARRAY_AGG(slug ORDER BY n DESC))[1] AS slug, SUM(n) AS comments,
      ROW_NUMBER() OVER (PARTITION BY term_id ORDER BY SUM(n) DESC, MIN(title)) AS rank
    FROM (
      SELECT it.term_id, mt.slug, COALESCE(NULLIF(mt.meta->>'display_title', ''), mt.title) AS title, COUNT(*) AS n
      FROM input_topics it JOIN matters raw ON raw.id = it.matter_id JOIN matters mt ON mt.id = COALESCE(raw.merged_into, raw.id)
      GROUP BY it.term_id, mt.id, mt.slug, mt.meta->>'display_title', mt.title
    ) per_topic
    GROUP BY term_id, title
  ),
  topic_counts AS (
    SELECT held.term_id, mt.id, COALESCE(NULLIF(mt.meta->>'display_title', ''), mt.title) AS title, mt.slug, COUNT(DISTINCT held.id) AS meetings,
      ROW_NUMBER() OVER (PARTITION BY held.term_id ORDER BY COUNT(DISTINCT held.id) DESC, MAX(a.id) DESC) AS rank
    FROM held
    JOIN agenda_items a ON a.meeting_id = held.id
    JOIN matters raw ON raw.id = a.matter_id
    JOIN matters mt ON mt.id = COALESCE(raw.merged_into, raw.id)
    GROUP BY held.term_id, mt.id, mt.meta->>'display_title', mt.title, mt.slug
    HAVING COUNT(DISTINCT held.id) > 1
  )
  SELECT term.id,
    (SELECT COUNT(*) FROM held h WHERE h.term_id = term.id)::integer,
    (SELECT COUNT(*) FROM held h WHERE h.term_id = term.id AND h.classification = 'Council' AND h.type = 'Regular Council')::integer,
    (SELECT COUNT(*) FROM held h WHERE h.term_id = term.id AND h.classification = 'Council' AND h.type IN ('Special Council', 'Inauguration'))::integer,
    (SELECT COUNT(*) FROM held h WHERE h.term_id = term.id AND h.classification = 'Council' AND h.type = 'Committee of the Whole')::integer,
    (SELECT COUNT(*) FROM held h WHERE h.term_id = term.id AND COALESCE(h.classification, '') <> 'Council')::integer,
    (SELECT COUNT(*) FROM decided d WHERE d.term_id = term.id AND d.result ~* '^\s*carried')::integer,
    (SELECT COUNT(*) FROM decided d WHERE d.term_id = term.id AND d.result ~* '^\s*defeated')::integer,
    (SELECT COUNT(*) FROM adopted a WHERE a.term_id = term.id)::integer,
    COALESCE((SELECT jsonb_agg(a.adopted_on ORDER BY a.adopted_on) FROM adopted a WHERE a.term_id = term.id), '[]'::jsonb),
    COALESCE((SELECT jsonb_agg(jsonb_build_object('month', mm.month, 'carried', mm.carried, 'defeated', mm.defeated) ORDER BY mm.month)
      FROM (SELECT to_char(d.meeting_date, 'YYYY-MM') AS month,
              COUNT(*) FILTER (WHERE d.result ~* '^\s*carried') AS carried, COUNT(*) FILTER (WHERE d.result ~* '^\s*defeated') AS defeated
            FROM decided d WHERE d.term_id = term.id GROUP BY 1) mm), '[]'::jsonb),
    COALESCE((SELECT jsonb_agg(jsonb_build_object('month', hm.month, 'meetings', hm.n) ORDER BY hm.month)
      FROM (SELECT to_char(h.meeting_date, 'YYYY-MM') AS month, COUNT(*) AS n FROM held h WHERE h.term_id = term.id GROUP BY 1) hm), '[]'::jsonb),
    (SELECT COUNT(*) FROM said s WHERE s.term_id = term.id)::integer,
    (SELECT COUNT(*) FROM written w WHERE w.term_id = term.id)::integer,
    ((SELECT COUNT(*) FROM said s WHERE s.term_id = term.id AND s.speaker->>'position' = 'supports')
      + (SELECT COUNT(*) FROM written w WHERE w.term_id = term.id AND w.letter->>'position' = 'supports'))::integer,
    ((SELECT COUNT(*) FROM said s WHERE s.term_id = term.id AND s.speaker->>'position' = 'opposes')
      + (SELECT COUNT(*) FROM written w WHERE w.term_id = term.id AND w.letter->>'position' = 'opposes'))::integer,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('title', pt.title, 'slug', pt.slug, 'comments', pt.comments) ORDER BY pt.rank)
      FROM public_topic_counts pt WHERE pt.term_id = term.id AND pt.rank <= 5), '[]'::jsonb),
    COALESCE((SELECT jsonb_agg(jsonb_build_object('title', tc.title, 'slug', tc.slug, 'meetings', tc.meetings) ORDER BY tc.rank)
      FROM topic_counts tc WHERE tc.term_id = term.id AND tc.rank <= 5), '[]'::jsonb)
  FROM term;
$$;

--
-- Name: delete_account_data(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.delete_account_data(p_user_id uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $_$
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
END $_$;

--
-- Name: drop_own_mention(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.drop_own_mention() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  IF NEW.matter_id IS NOT NULL THEN
    DELETE FROM matter_links WHERE kind = 'mention' AND matter_id = NEW.matter_id AND agenda_item_id = NEW.id;
  END IF;
  RETURN NULL;
END $$;

--
-- Name: election_slug_base(text, date); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.election_slug_base(name text, election_date date) RETURNS text
    LANGUAGE plpgsql IMMUTABLE
    AS $_$
DECLARE
  base text := public.generate_slug_capped(COALESCE(nullif(trim(name), ''), election_date::text || ' election'), 60);
BEGIN
  IF base IS NULL OR base = '' THEN base := 'election'; END IF;
  IF base ~ '^[0-9]+$' THEN base := base || '-election'; END IF;
  RETURN base;
END;
$_$;

--
-- Name: email_alert_eligible(uuid, date); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.email_alert_eligible(p_message uuid, p_start_date date) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
 SELECT EXISTS(SELECT 1 FROM email_messages e JOIN find_meeting_subscribers((SELECT meeting_id FROM email_messages WHERE id=p_message)) s
 ON s.user_id=e.user_id AND s.notification_email=e.recipient AND s.consent_at IS NOT DISTINCT FROM e.consent_at
 JOIN meetings m ON m.id=e.meeting_id WHERE e.id=p_message AND e.status='attempting' AND e.expires_at>now()
 AND (m.has_minutes OR m.has_transcript) AND p_start_date IS NOT NULL AND (e.is_test OR m.meeting_date>=p_start_date));
$$;

--
-- Name: email_distance_m(double precision, double precision, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.email_distance_m(lat1 double precision, lng1 double precision, location jsonb) RETURNS double precision
    LANGUAGE plpgsql IMMUTABLE
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE lat2 double precision; lng2 double precision; a double precision;
BEGIN
 lat2:=(location->>'lat')::double precision; lng2:=(location->>'lng')::double precision;
 IF lat1 IS NULL OR lng1 IS NULL OR lat2 IS NULL OR lng2 IS NULL OR abs(lat1)>90 OR abs(lat2)>90 OR abs(lng1)>180 OR abs(lng2)>180 THEN RETURN NULL; END IF;
 a:=sin(radians(lat2-lat1)/2)^2+cos(radians(lat1))*cos(radians(lat2))*sin(radians(lng2-lng1)/2)^2;
 RETURN 6371000*2*asin(sqrt(least(1,greatest(0,a))));
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN RETURN NULL;
END $$;

--
-- Name: enqueue_meeting_emails(bigint, date, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.enqueue_meeting_emails(p_meeting bigint, p_start_date date, p_test_recipient text DEFAULT NULL::text) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
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

--
-- Name: fail_calendar_sync(uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.fail_calendar_sync(p_token uuid, p_error text) RETURNS void
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  UPDATE calendar_sync_state SET status='failed',finished_at=now(),lease_until=NULL,
    last_error=left(p_error,300) WHERE token=p_token AND status='running';
$$;

--
-- Name: find_meeting_subscribers(bigint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.find_meeting_subscribers(target_meeting_id bigint) RETURNS TABLE(user_id uuid, notification_email text, consent_at timestamp with time zone)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
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

--
-- Name: finish_email_alert(uuid, uuid, text, text, text, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.finish_email_alert(p_message uuid, p_lease uuid, p_state text, p_provider_id text DEFAULT NULL::text, p_error text DEFAULT NULL::text, p_retry_seconds integer DEFAULT 60) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
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

--
-- Name: flatten_matter_merge(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.flatten_matter_merge() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
DECLARE hops integer := 0;
BEGIN
  IF NEW.merged_into IS NOT NULL THEN
    WHILE (SELECT merged_into FROM matters WHERE id = NEW.merged_into) IS NOT NULL LOOP
      NEW.merged_into := (SELECT merged_into FROM matters WHERE id = NEW.merged_into);
      hops := hops + 1;
      IF hops > 20 THEN RAISE EXCEPTION 'merge chain from topic % does not end', NEW.id; END IF;
    END LOOP;
    IF NEW.merged_into = NEW.id THEN RAISE EXCEPTION 'topic % cannot be merged into itself', NEW.id; END IF;
  END IF;
  RETURN NEW;
END $$;

--
-- Name: freeze_email_alert(uuid, uuid, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.freeze_email_alert(p_message uuid, p_lease uuid, p_body jsonb) RETURNS jsonb
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
 UPDATE email_messages SET provider_payload=coalesce(provider_payload,p_body)
 WHERE id=p_message AND lease_token=p_lease AND status='attempting' RETURNING provider_payload;
$$;

--
-- Name: generate_slug(text, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.generate_slug(input text, max_len integer DEFAULT 60) RETURNS text
    LANGUAGE sql IMMUTABLE STRICT
    AS $$
  SELECT left(
    trim(BOTH '-' FROM lower(regexp_replace(trim(input), '[^a-zA-Z0-9]+', '-', 'g'))),
    max_len
  );
$$;

--
-- Name: generate_slug_capped(text, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.generate_slug_capped(input text, max_len integer DEFAULT 60) RETURNS text
    LANGUAGE plpgsql IMMUTABLE STRICT
    AS $_$
DECLARE
  full_slug text := public.generate_slug(input, 1000);
  capped text;
BEGIN
  IF length(full_slug) <= max_len THEN RETURN full_slug; END IF;
  capped := left(full_slug, max_len);
  -- Cut mid-word: drop the partial trailing word (unless it is the only word).
  IF substr(full_slug, max_len + 1, 1) <> '-' AND position('-' IN capped) > 0 THEN
    capped := regexp_replace(capped, '-[^-]*$', '');
  END IF;
  -- Don't end a truncated slug on a dangling connective ("...-and").
  capped := regexp_replace(capped, '(-(and|or|of|the|to|for|a|an|in|on|at|with|by|from|&))+$', '');
  RETURN trim(BOTH '-' FROM capped);
END;
$_$;

--
-- Name: get_meetings_with_stats(bigint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_meetings_with_stats(filter_municipality_id bigint DEFAULT NULL::bigint) RETURNS TABLE(meeting_id bigint, motion_carried_count integer, motion_defeated_count integer, motion_other_count integer, topics text[])
    LANGUAGE sql STABLE
    SET search_path TO 'public'
    AS $$
  WITH motion_counts AS (
    SELECT
      m.meeting_id,
      count(*) FILTER (WHERE upper(m.result) IN ('CARRIED', 'CARRIED AS AMENDED', 'AMENDED', 'CARRRIED')) AS carried,
      count(*) FILTER (WHERE upper(m.result) IN ('DEFEATED', 'FAILED', 'FAILED FOR LACK OF A SECONDER', 'FAILED FOR LACK OF SECONDER', 'NOT CARRIED')) AS defeated,
      count(*) FILTER (WHERE upper(m.result) NOT IN ('CARRIED', 'CARRIED AS AMENDED', 'AMENDED', 'CARRRIED', 'DEFEATED', 'FAILED', 'FAILED FOR LACK OF A SECONDER', 'FAILED FOR LACK OF SECONDER', 'NOT CARRIED') OR m.result IS NULL) AS other
    FROM motions m
    GROUP BY m.meeting_id
  ),
  meeting_topics AS (
    SELECT
      ai.meeting_id,
      array_agg(DISTINCT normalize_category_to_topic(ai.category)) FILTER (WHERE normalize_category_to_topic(ai.category) != 'General') AS topics
    FROM agenda_items ai
    WHERE ai.category IS NOT NULL
    GROUP BY ai.meeting_id
  )
  SELECT
    mtg.id AS meeting_id,
    coalesce(mc.carried, 0)::int AS motion_carried_count,
    coalesce(mc.defeated, 0)::int AS motion_defeated_count,
    coalesce(mc.other, 0)::int AS motion_other_count,
    coalesce(mt.topics, ARRAY[]::text[]) AS topics
  FROM meetings mtg
  LEFT JOIN motion_counts mc ON mc.meeting_id = mtg.id
  LEFT JOIN meeting_topics mt ON mt.meeting_id = mtg.id
  WHERE (filter_municipality_id IS NULL OR mtg.municipality_id = filter_municipality_id);
$$;

--
-- Name: get_speaking_time_by_meeting(bigint, date, date); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_speaking_time_by_meeting(p_person_id bigint, p_start_date date DEFAULT NULL::date, p_end_date date DEFAULT NULL::date) RETURNS TABLE(meeting_id bigint, meeting_date date, seconds_spoken numeric, segment_count bigint)
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
BEGIN
  RETURN QUERY
  SELECT
    ts.meeting_id,
    m.meeting_date::date AS meeting_date,
    round(sum(ts.end_time - ts.start_time)::numeric, 1) AS seconds_spoken,
    count(*) AS segment_count
  FROM transcript_segments ts
  JOIN meetings m ON ts.meeting_id = m.id
  WHERE ts.person_id = p_person_id
    AND (p_start_date IS NULL OR m.meeting_date >= p_start_date)
    AND (p_end_date IS NULL OR m.meeting_date <= p_end_date)
  GROUP BY ts.meeting_id, m.meeting_date
  ORDER BY m.meeting_date ASC;
END;
$$;

--
-- Name: get_speaking_time_by_meeting(bigint, date, date, bigint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_speaking_time_by_meeting(p_person_id bigint, p_start_date date DEFAULT NULL::date, p_end_date date DEFAULT NULL::date, filter_municipality_id bigint DEFAULT NULL::bigint) RETURNS TABLE(meeting_id bigint, meeting_date date, seconds_spoken numeric, segment_count bigint)
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
BEGIN
  RETURN QUERY
  SELECT
    ts.meeting_id,
    m.meeting_date::date AS meeting_date,
    round(sum(ts.end_time - ts.start_time)::numeric, 1) AS seconds_spoken,
    count(*) AS segment_count
  FROM transcript_segments ts
  JOIN meetings m ON ts.meeting_id = m.id
  WHERE ts.person_id = p_person_id
    AND (p_start_date IS NULL OR m.meeting_date >= p_start_date)
    AND (p_end_date IS NULL OR m.meeting_date <= p_end_date)
    AND (filter_municipality_id IS NULL OR m.municipality_id = filter_municipality_id)
  GROUP BY ts.meeting_id, m.meeting_date
  ORDER BY m.meeting_date ASC;
END;
$$;

--
-- Name: get_speaking_time_by_topic(bigint, date, date); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_speaking_time_by_topic(p_person_id bigint, p_start_date date DEFAULT NULL::date, p_end_date date DEFAULT NULL::date) RETURNS TABLE(topic text, total_seconds numeric, segment_count bigint)
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
BEGIN
  RETURN QUERY
  SELECT
    coalesce(
      normalize_category_to_topic(ai.category),
      'General'
    ) AS topic,
    round(sum(ts.end_time - ts.start_time)::numeric, 1) AS total_seconds,
    count(*) AS segment_count
  FROM transcript_segments ts
  JOIN meetings m ON ts.meeting_id = m.id
  LEFT JOIN agenda_items ai ON (
    -- Direct link via agenda_item_id if available
    (ts.agenda_item_id IS NOT NULL AND ai.id = ts.agenda_item_id)
    OR
    -- Time-overlap fallback: segment start_time falls within agenda item discussion window
    (ts.agenda_item_id IS NULL
     AND ai.meeting_id = ts.meeting_id
     AND ai.discussion_start_time IS NOT NULL
     AND ai.discussion_end_time IS NOT NULL
     AND ts.start_time >= ai.discussion_start_time
     AND ts.start_time < ai.discussion_end_time)
  )
  WHERE ts.person_id = p_person_id
    AND (p_start_date IS NULL OR m.meeting_date >= p_start_date)
    AND (p_end_date IS NULL OR m.meeting_date <= p_end_date)
  GROUP BY normalize_category_to_topic(ai.category)
  ORDER BY sum(ts.end_time - ts.start_time) DESC;
END;
$$;

--
-- Name: get_speaking_time_by_topic(bigint, date, date, bigint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_speaking_time_by_topic(p_person_id bigint, p_start_date date DEFAULT NULL::date, p_end_date date DEFAULT NULL::date, filter_municipality_id bigint DEFAULT NULL::bigint) RETURNS TABLE(topic text, total_seconds numeric, segment_count bigint)
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
BEGIN
  RETURN QUERY
  SELECT
    coalesce(
      normalize_category_to_topic(ai.category),
      'General'
    ) AS topic,
    round(sum(ts.end_time - ts.start_time)::numeric, 1) AS total_seconds,
    count(*) AS segment_count
  FROM transcript_segments ts
  JOIN meetings m ON ts.meeting_id = m.id
  LEFT JOIN agenda_items ai ON (
    -- Direct link via agenda_item_id if available
    (ts.agenda_item_id IS NOT NULL AND ai.id = ts.agenda_item_id)
    OR
    -- Time-overlap fallback: segment start_time falls within agenda item discussion window
    (ts.agenda_item_id IS NULL
     AND ai.meeting_id = ts.meeting_id
     AND ai.discussion_start_time IS NOT NULL
     AND ai.discussion_end_time IS NOT NULL
     AND ts.start_time >= ai.discussion_start_time
     AND ts.start_time < ai.discussion_end_time)
  )
  WHERE ts.person_id = p_person_id
    AND (p_start_date IS NULL OR m.meeting_date >= p_start_date)
    AND (p_end_date IS NULL OR m.meeting_date <= p_end_date)
    AND (filter_municipality_id IS NULL OR m.municipality_id = filter_municipality_id)
  GROUP BY normalize_category_to_topic(ai.category)
  ORDER BY sum(ts.end_time - ts.start_time) DESC;
END;
$$;

--
-- Name: get_speaking_time_stats(date, date); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_speaking_time_stats(p_start_date date DEFAULT NULL::date, p_end_date date DEFAULT NULL::date) RETURNS TABLE(person_id bigint, person_name text, image_url text, total_seconds numeric, meeting_count bigint, segment_count bigint)
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
BEGIN
  RETURN QUERY
  SELECT
    ts.person_id,
    p.name AS person_name,
    p.image_url,
    round(sum(ts.end_time - ts.start_time)::numeric, 1) AS total_seconds,
    count(DISTINCT ts.meeting_id) AS meeting_count,
    count(*) AS segment_count
  FROM transcript_segments ts
  JOIN people p ON ts.person_id = p.id
  JOIN meetings m ON ts.meeting_id = m.id
  WHERE ts.person_id IS NOT NULL
    AND (p_start_date IS NULL OR m.meeting_date >= p_start_date)
    AND (p_end_date IS NULL OR m.meeting_date <= p_end_date)
  GROUP BY ts.person_id, p.name, p.image_url
  ORDER BY sum(ts.end_time - ts.start_time) DESC;
END;
$$;

--
-- Name: get_speaking_time_stats(date, date, bigint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_speaking_time_stats(p_start_date date DEFAULT NULL::date, p_end_date date DEFAULT NULL::date, filter_municipality_id bigint DEFAULT NULL::bigint) RETURNS TABLE(person_id bigint, person_name text, image_url text, total_seconds numeric, meeting_count bigint, segment_count bigint)
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
BEGIN
  RETURN QUERY
  SELECT
    ts.person_id,
    p.name AS person_name,
    p.image_url,
    round(sum(ts.end_time - ts.start_time)::numeric, 1) AS total_seconds,
    count(DISTINCT ts.meeting_id) AS meeting_count,
    count(*) AS segment_count
  FROM transcript_segments ts
  JOIN people p ON ts.person_id = p.id
  JOIN meetings m ON ts.meeting_id = m.id
  WHERE ts.person_id IS NOT NULL
    AND (p_start_date IS NULL OR m.meeting_date >= p_start_date)
    AND (p_end_date IS NULL OR m.meeting_date <= p_end_date)
    AND (filter_municipality_id IS NULL OR m.municipality_id = filter_municipality_id)
  GROUP BY ts.person_id, p.name, p.image_url
  ORDER BY sum(ts.end_time - ts.start_time) DESC;
END;
$$;

--
-- Name: get_unclassified_agenda_items(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_unclassified_agenda_items() RETURNS TABLE(id bigint, category text)
    LANGUAGE sql
    SET search_path TO 'public'
    AS $$
  SELECT ai.id, ai.category
  FROM agenda_items ai
  WHERE NOT EXISTS (
    SELECT 1 FROM agenda_item_topics ait WHERE ait.agenda_item_id = ai.id
  )
  ORDER BY ai.id;
$$;

--
-- Name: hybrid_search_bylaw_chunks(text, public.halfvec, integer, double precision, double precision, double precision, bigint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.hybrid_search_bylaw_chunks(query_text text, query_embedding public.halfvec, match_count integer, full_text_weight double precision DEFAULT 1.0, semantic_weight double precision DEFAULT 1.0, rrf_k double precision DEFAULT 50, filter_municipality_id bigint DEFAULT NULL::bigint) RETURNS TABLE(id bigint, bylaw_id bigint, chunk_index integer, text_content text, bylaw_title text, bylaw_number text, rank_score double precision)
    LANGUAGE sql
    SET search_path TO 'public'
    SET "hnsw.ef_search" TO '100'
    SET "hnsw.iterative_scan" TO 'relaxed_order'
    AS $$
WITH full_text AS (
  SELECT
    bc.id,
    ROW_NUMBER() OVER (ORDER BY ts_rank_cd(bc.text_search, websearch_to_tsquery(query_text)) DESC) AS rank_ix
  FROM bylaw_chunks bc
  JOIN bylaws b2 ON b2.id = bc.bylaw_id
  WHERE bc.text_search @@ websearch_to_tsquery(query_text)
    AND (filter_municipality_id IS NULL OR b2.municipality_id = filter_municipality_id)
  ORDER BY rank_ix
  LIMIT LEAST(match_count, 30) * 2
),
nearest AS (
  SELECT bc.id, bc.embedding <=> query_embedding AS distance
  FROM bylaw_chunks bc
  JOIN bylaws b2 ON b2.id = bc.bylaw_id
  WHERE bc.embedding IS NOT NULL
    AND (filter_municipality_id IS NULL OR b2.municipality_id = filter_municipality_id)
  ORDER BY bc.embedding <=> query_embedding
  LIMIT LEAST(match_count, 30) * 2
),
semantic AS (
  SELECT nearest.id, ROW_NUMBER() OVER (ORDER BY nearest.distance) AS rank_ix FROM nearest
)
SELECT
  bylaw_chunks.id,
  bylaw_chunks.bylaw_id,
  bylaw_chunks.chunk_index,
  LEFT(bylaw_chunks.text_content, 500) AS text_content,
  b.title AS bylaw_title,
  b.bylaw_number,
  (COALESCE(1.0 / (rrf_k + full_text.rank_ix), 0.0) * full_text_weight +
   COALESCE(1.0 / (rrf_k + semantic.rank_ix), 0.0) * semantic_weight)::float AS rank_score
FROM full_text
FULL OUTER JOIN semantic ON full_text.id = semantic.id
JOIN bylaw_chunks ON COALESCE(full_text.id, semantic.id) = bylaw_chunks.id
JOIN bylaws b ON bylaw_chunks.bylaw_id = b.id
ORDER BY rank_score DESC
LIMIT LEAST(match_count, 30);
$$;

--
-- Name: hybrid_search_document_sections(text, public.halfvec, integer, double precision, double precision, integer, date, date, bigint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.hybrid_search_document_sections(query_text text, query_embedding public.halfvec, match_count integer, full_text_weight double precision DEFAULT 1, semantic_weight double precision DEFAULT 1, rrf_k integer DEFAULT 50, date_from date DEFAULT NULL::date, date_to date DEFAULT NULL::date, filter_municipality_id bigint DEFAULT NULL::bigint) RETURNS TABLE(id bigint, document_id bigint, meeting_id bigint, agenda_item_id bigint, section_title text, content text, rank_score double precision)
    LANGUAGE plpgsql
    SET search_path TO 'public'
    SET "hnsw.ef_search" TO '400'
    SET "hnsw.iterative_scan" TO 'relaxed_order'
    SET plan_cache_mode TO 'force_custom_plan'
    AS $$
#variable_conflict use_column
DECLARE
  k integer := LEAST(match_count, 30) * 2;
BEGIN
  RETURN QUERY
  WITH full_text AS (
    SELECT
      ds.id,
      ROW_NUMBER() OVER (ORDER BY ts_rank_cd(ds.text_search, websearch_to_tsquery(query_text)) DESC) AS rank_ix
    FROM document_sections ds
    JOIN documents d ON d.id = ds.document_id
    JOIN meetings mt ON mt.id = d.meeting_id
    WHERE ds.text_search @@ websearch_to_tsquery(query_text)
      AND (date_from IS NULL OR mt.meeting_date >= date_from)
      AND (date_to IS NULL OR mt.meeting_date <= date_to)
      AND (filter_municipality_id IS NULL OR ds.municipality_id = filter_municipality_id)
    ORDER BY rank_ix
    LIMIT k
  ),
  nearest AS (
    SELECT ds.id, ds.embedding <=> query_embedding AS distance
    FROM document_sections ds
    JOIN documents d ON d.id = ds.document_id
    JOIN meetings mt ON mt.id = d.meeting_id
    WHERE ds.embedding IS NOT NULL
      AND (date_from IS NULL OR mt.meeting_date >= date_from)
      AND (date_to IS NULL OR mt.meeting_date <= date_to)
      AND (filter_municipality_id IS NULL OR ds.municipality_id = filter_municipality_id)
    ORDER BY ds.embedding <=> query_embedding
    LIMIT 60
  ),
  semantic AS (
    SELECT n.id, n.rank_ix
    FROM (SELECT nearest.id, ROW_NUMBER() OVER (ORDER BY nearest.distance) AS rank_ix FROM nearest) n
    WHERE n.rank_ix <= k
  )
  SELECT
    document_sections.id,
    document_sections.document_id,
    documents.meeting_id,
    document_sections.agenda_item_id,
    document_sections.section_title,
    LEFT(document_sections.section_text, 500) AS content,
    (COALESCE(1.0 / (rrf_k + full_text.rank_ix), 0.0) * full_text_weight +
     COALESCE(1.0 / (rrf_k + semantic.rank_ix), 0.0) * semantic_weight)::float AS rank_score
  FROM full_text
  FULL OUTER JOIN semantic ON full_text.id = semantic.id
  JOIN document_sections ON COALESCE(full_text.id, semantic.id) = document_sections.id
  JOIN documents ON documents.id = document_sections.document_id
  ORDER BY rank_score DESC
  LIMIT LEAST(match_count, 30);
END;
$$;

--
-- Name: hybrid_search_key_statements(text, public.halfvec, integer, double precision, double precision, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.hybrid_search_key_statements(query_text text, query_embedding public.halfvec, match_count integer, full_text_weight double precision DEFAULT 1, semantic_weight double precision DEFAULT 1, rrf_k integer DEFAULT 50) RETURNS TABLE(id bigint, meeting_id bigint, agenda_item_id bigint, speaker_name text, statement_type text, statement_text text, context text, rank_score double precision)
    LANGUAGE sql
    SET search_path TO 'public'
    AS $$
WITH full_text AS (
  SELECT
    ks.id,
    ROW_NUMBER() OVER (ORDER BY ts_rank_cd(ks.text_search, websearch_to_tsquery(query_text)) DESC) AS rank_ix
  FROM key_statements ks
  WHERE (ks.evidence_kind IS NULL OR ks.evidence_kind='transcript')
    AND ks.text_search @@ websearch_to_tsquery(query_text)
  ORDER BY rank_ix
  LIMIT LEAST(match_count, 30) * 2
),
semantic AS (
  SELECT
    ks.id,
    ROW_NUMBER() OVER (ORDER BY ks.embedding <=> query_embedding) AS rank_ix
  FROM key_statements ks
  WHERE (ks.evidence_kind IS NULL OR ks.evidence_kind='transcript')
    AND ks.embedding IS NOT NULL
  ORDER BY rank_ix
  LIMIT LEAST(match_count, 30) * 2
)
SELECT
  key_statements.id,
  key_statements.meeting_id,
  key_statements.agenda_item_id,
  key_statements.speaker_name,
  key_statements.statement_type,
  key_statements.statement_text,
  key_statements.context,
  (COALESCE(1.0 / (rrf_k + full_text.rank_ix), 0.0) * full_text_weight +
   COALESCE(1.0 / (rrf_k + semantic.rank_ix), 0.0) * semantic_weight)::float AS rank_score
FROM full_text
FULL OUTER JOIN semantic ON full_text.id = semantic.id
JOIN key_statements ON COALESCE(full_text.id, semantic.id) = key_statements.id
ORDER BY rank_score DESC
LIMIT LEAST(match_count, 30);
$$;

--
-- Name: hybrid_search_key_statements(text, public.halfvec, integer, double precision, double precision, integer, date, date, bigint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.hybrid_search_key_statements(query_text text, query_embedding public.halfvec, match_count integer, full_text_weight double precision DEFAULT 1, semantic_weight double precision DEFAULT 1, rrf_k integer DEFAULT 50, date_from date DEFAULT NULL::date, date_to date DEFAULT NULL::date, filter_municipality_id bigint DEFAULT NULL::bigint) RETURNS TABLE(id bigint, meeting_id bigint, agenda_item_id bigint, speaker_name text, statement_type text, statement_text text, context text, rank_score double precision)
    LANGUAGE plpgsql
    SET search_path TO 'public'
    SET "hnsw.ef_search" TO '400'
    SET "hnsw.iterative_scan" TO 'relaxed_order'
    SET plan_cache_mode TO 'force_custom_plan'
    AS $$
#variable_conflict use_column
DECLARE
  k integer := LEAST(match_count, 30) * 2;
BEGIN
  RETURN QUERY
  WITH full_text AS (
    SELECT
      ks.id,
      ROW_NUMBER() OVER (ORDER BY ts_rank_cd(ks.text_search, websearch_to_tsquery(query_text)) DESC) AS rank_ix
    FROM key_statements ks
    JOIN meetings mt ON mt.id = ks.meeting_id
    WHERE (ks.evidence_kind IS NULL OR ks.evidence_kind = 'transcript')
      AND ks.text_search @@ websearch_to_tsquery(query_text)
      AND (date_from IS NULL OR mt.meeting_date >= date_from)
      AND (date_to IS NULL OR mt.meeting_date <= date_to)
      AND (filter_municipality_id IS NULL OR ks.municipality_id = filter_municipality_id)
    ORDER BY rank_ix
    LIMIT k
  ),
  nearest AS (
    SELECT ks.id, ks.embedding <=> query_embedding AS distance
    FROM key_statements ks
    JOIN meetings mt ON mt.id = ks.meeting_id
    WHERE (ks.evidence_kind IS NULL OR ks.evidence_kind = 'transcript')
      AND ks.embedding IS NOT NULL
      AND (date_from IS NULL OR mt.meeting_date >= date_from)
      AND (date_to IS NULL OR mt.meeting_date <= date_to)
      AND (filter_municipality_id IS NULL OR ks.municipality_id = filter_municipality_id)
    ORDER BY ks.embedding <=> query_embedding
    LIMIT 60
  ),
  semantic AS (
    SELECT n.id, n.rank_ix
    FROM (SELECT nearest.id, ROW_NUMBER() OVER (ORDER BY nearest.distance) AS rank_ix FROM nearest) n
    WHERE n.rank_ix <= k
  )
  SELECT
    key_statements.id,
    key_statements.meeting_id,
    key_statements.agenda_item_id,
    key_statements.speaker_name,
    key_statements.statement_type,
    key_statements.statement_text,
    key_statements.context,
    (COALESCE(1.0 / (rrf_k + full_text.rank_ix), 0.0) * full_text_weight +
     COALESCE(1.0 / (rrf_k + semantic.rank_ix), 0.0) * semantic_weight)::float AS rank_score
  FROM full_text
  FULL OUTER JOIN semantic ON full_text.id = semantic.id
  JOIN key_statements ON COALESCE(full_text.id, semantic.id) = key_statements.id
  ORDER BY rank_score DESC
  LIMIT LEAST(match_count, 30);
END;
$$;

--
-- Name: hybrid_search_motions(text, public.halfvec, integer, double precision, double precision, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.hybrid_search_motions(query_text text, query_embedding public.halfvec, match_count integer, full_text_weight double precision DEFAULT 1, semantic_weight double precision DEFAULT 1, rrf_k integer DEFAULT 50) RETURNS TABLE(id bigint, meeting_id bigint, text_content text, plain_english_summary text, result text, mover text, seconder text, rank_score double precision)
    LANGUAGE sql
    SET search_path TO 'public'
    AS $$
WITH full_text AS (
  SELECT
    m.id,
    ROW_NUMBER() OVER (ORDER BY ts_rank_cd(m.text_search, websearch_to_tsquery(query_text)) DESC) AS rank_ix
  FROM motions m
  WHERE m.text_search @@ websearch_to_tsquery(query_text)
  ORDER BY rank_ix
  LIMIT LEAST(match_count, 30) * 2
),
semantic AS (
  SELECT
    m.id,
    ROW_NUMBER() OVER (ORDER BY m.embedding <=> query_embedding) AS rank_ix
  FROM motions m
  WHERE m.embedding IS NOT NULL
  ORDER BY rank_ix
  LIMIT LEAST(match_count, 30) * 2
)
SELECT
  motions.id,
  motions.meeting_id,
  motions.text_content,
  motions.plain_english_summary,
  motions.result,
  motions.mover,
  motions.seconder,
  (COALESCE(1.0 / (rrf_k + full_text.rank_ix), 0.0) * full_text_weight +
   COALESCE(1.0 / (rrf_k + semantic.rank_ix), 0.0) * semantic_weight)::float AS rank_score
FROM full_text
FULL OUTER JOIN semantic ON full_text.id = semantic.id
JOIN motions ON COALESCE(full_text.id, semantic.id) = motions.id
ORDER BY rank_score DESC
LIMIT LEAST(match_count, 30);
$$;

--
-- Name: hybrid_search_motions(text, public.halfvec, integer, double precision, double precision, integer, date, date, bigint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.hybrid_search_motions(query_text text, query_embedding public.halfvec, match_count integer, full_text_weight double precision DEFAULT 1, semantic_weight double precision DEFAULT 1, rrf_k integer DEFAULT 50, date_from date DEFAULT NULL::date, date_to date DEFAULT NULL::date, filter_municipality_id bigint DEFAULT NULL::bigint) RETURNS TABLE(id bigint, meeting_id bigint, agenda_item_id bigint, text_content text, plain_english_summary text, result text, mover text, seconder text, rank_score double precision)
    LANGUAGE plpgsql
    SET search_path TO 'public'
    SET "hnsw.ef_search" TO '400'
    SET "hnsw.iterative_scan" TO 'relaxed_order'
    SET plan_cache_mode TO 'force_custom_plan'
    AS $$
#variable_conflict use_column
DECLARE
  k integer := LEAST(match_count, 30) * 2;
BEGIN
  RETURN QUERY
  WITH full_text AS (
    SELECT
      m.id,
      ROW_NUMBER() OVER (ORDER BY ts_rank_cd(m.text_search, websearch_to_tsquery(query_text)) DESC) AS rank_ix
    FROM motions m
    JOIN meetings mt ON mt.id = m.meeting_id
    WHERE m.text_search @@ websearch_to_tsquery(query_text)
      AND (date_from IS NULL OR mt.meeting_date >= date_from)
      AND (date_to IS NULL OR mt.meeting_date <= date_to)
      AND (filter_municipality_id IS NULL OR mt.municipality_id = filter_municipality_id)
    ORDER BY rank_ix
    LIMIT k
  ),
  nearest AS (
    SELECT m.id, m.embedding <=> query_embedding AS distance
    FROM motions m
    JOIN meetings mt ON mt.id = m.meeting_id
    WHERE m.embedding IS NOT NULL
      AND (date_from IS NULL OR mt.meeting_date >= date_from)
      AND (date_to IS NULL OR mt.meeting_date <= date_to)
      AND (filter_municipality_id IS NULL OR mt.municipality_id = filter_municipality_id)
    ORDER BY m.embedding <=> query_embedding
    LIMIT 60
  ),
  semantic AS (
    SELECT n.id, n.rank_ix
    FROM (SELECT nearest.id, ROW_NUMBER() OVER (ORDER BY nearest.distance) AS rank_ix FROM nearest) n
    WHERE n.rank_ix <= k
  )
  SELECT
    motions.id,
    motions.meeting_id,
    motions.agenda_item_id,
    motions.text_content,
    motions.plain_english_summary,
    motions.result,
    motions.mover,
    motions.seconder,
    (COALESCE(1.0 / (rrf_k + full_text.rank_ix), 0.0) * full_text_weight +
     COALESCE(1.0 / (rrf_k + semantic.rank_ix), 0.0) * semantic_weight)::float AS rank_score
  FROM full_text
  FULL OUTER JOIN semantic ON full_text.id = semantic.id
  JOIN motions ON COALESCE(full_text.id, semantic.id) = motions.id
  ORDER BY rank_score DESC
  LIMIT LEAST(match_count, 30);
END;
$$;

--
-- Name: invalidate_meeting_vimeo_cache(bigint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.invalidate_meeting_vimeo_cache(p_meeting_id bigint) RETURNS TABLE(video_url text)
    LANGUAGE sql
    SET search_path TO 'public'
    AS $$
  UPDATE public.meetings
  SET meta = COALESCE(meta, '{}'::jsonb) || jsonb_build_object(
    'vimeo_direct_url', NULL,
    'vimeo_direct_audio_url', NULL,
    'vimeo_direct_url_updated_at', NULL,
    'vimeo_cache_invalidated_at', to_jsonb(now())
  )
  WHERE id = p_meeting_id
  RETURNING meetings.video_url;
$$;

--
-- Name: is_public_input_item(text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.is_public_input_item(p_title text, p_category text) RETURNS boolean
    LANGUAGE sql IMMUTABLE
    SET search_path TO 'public', 'pg_temp'
    AS $$
  SELECT lower(btrim(coalesce(p_category, ''))) = 'public input'
    OR coalesce(p_title, '') ~* 'public\s+(participation|input|comment|hearing\s+submission)|correspondence|delegation|written\s+submission|petition'
$$;

--
-- Name: match_agenda_items(public.halfvec, double precision, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.match_agenda_items(query_embedding public.halfvec, match_threshold double precision, match_count integer) RETURNS TABLE(id bigint, meeting_id bigint, title text, plain_english_summary text, debate_summary text, similarity double precision)
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
BEGIN
  RETURN QUERY
  SELECT
    ai.id, ai.meeting_id, ai.title, ai.plain_english_summary, ai.debate_summary,
    1 - (ai.embedding <=> query_embedding) AS similarity
  FROM agenda_items ai
  WHERE 1 - (ai.embedding <=> query_embedding) > match_threshold
  ORDER BY ai.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

--
-- Name: FUNCTION match_agenda_items(query_embedding public.halfvec, match_threshold double precision, match_count integer); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.match_agenda_items(query_embedding public.halfvec, match_threshold double precision, match_count integer) IS 'Semantic similarity search for agenda items.';

--
-- Name: match_agenda_items(public.halfvec, double precision, integer, bigint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.match_agenda_items(query_embedding public.halfvec, match_threshold double precision, match_count integer, filter_municipality_id bigint DEFAULT NULL::bigint) RETURNS TABLE(id bigint, meeting_id bigint, title text, plain_english_summary text, debate_summary text, similarity double precision)
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
BEGIN
  RETURN QUERY
  SELECT
    ai.id, ai.meeting_id, ai.title, ai.plain_english_summary, ai.debate_summary,
    1 - (ai.embedding <=> query_embedding) AS similarity
  FROM agenda_items ai
  JOIN meetings mt ON mt.id = ai.meeting_id
  WHERE 1 - (ai.embedding <=> query_embedding) > match_threshold
    AND (filter_municipality_id IS NULL OR mt.municipality_id = filter_municipality_id)
  ORDER BY ai.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

--
-- Name: match_bylaw_chunks(public.halfvec, double precision, integer, bigint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.match_bylaw_chunks(query_embedding public.halfvec, match_threshold double precision, match_count integer, filter_bylaw_id bigint DEFAULT NULL::bigint) RETURNS TABLE(id bigint, bylaw_id bigint, chunk_index integer, text_content text, similarity double precision)
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
BEGIN
  RETURN QUERY
  SELECT
    bc.id,
    bc.bylaw_id,
    bc.chunk_index,
    bc.text_content,
    1 - (bc.embedding <=> query_embedding) AS similarity
  FROM bylaw_chunks bc
  WHERE (filter_bylaw_id IS NULL OR bc.bylaw_id = filter_bylaw_id)
    AND 1 - (bc.embedding <=> query_embedding) > match_threshold
  ORDER BY bc.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

--
-- Name: FUNCTION match_bylaw_chunks(query_embedding public.halfvec, match_threshold double precision, match_count integer, filter_bylaw_id bigint); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.match_bylaw_chunks(query_embedding public.halfvec, match_threshold double precision, match_count integer, filter_bylaw_id bigint) IS 'Semantic similarity search for bylaw segments.';

--
-- Name: match_bylaws(public.halfvec, double precision, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.match_bylaws(query_embedding public.halfvec, match_threshold double precision, match_count integer) RETURNS TABLE(id bigint, title text, bylaw_number text, plain_english_summary text, similarity double precision)
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
BEGIN
  RETURN QUERY
  SELECT
    b.id,
    b.title,
    b.bylaw_number,
    b.plain_english_summary,
    1 - (b.embedding <=> query_embedding) AS similarity
  FROM bylaws b
  WHERE 1 - (b.embedding <=> query_embedding) > match_threshold
  ORDER BY b.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

--
-- Name: FUNCTION match_bylaws(query_embedding public.halfvec, match_threshold double precision, match_count integer); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.match_bylaws(query_embedding public.halfvec, match_threshold double precision, match_count integer) IS 'Semantic similarity search for bylaws.';

--
-- Name: match_bylaws(public.halfvec, double precision, integer, bigint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.match_bylaws(query_embedding public.halfvec, match_threshold double precision, match_count integer, filter_municipality_id bigint DEFAULT NULL::bigint) RETURNS TABLE(id bigint, title text, bylaw_number text, plain_english_summary text, similarity double precision)
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
BEGIN
  RETURN QUERY
  SELECT
    b.id,
    b.title,
    b.bylaw_number,
    b.plain_english_summary,
    1 - (b.embedding <=> query_embedding) AS similarity
  FROM bylaws b
  WHERE 1 - (b.embedding <=> query_embedding) > match_threshold
    AND (filter_municipality_id IS NULL OR b.municipality_id = filter_municipality_id)
  ORDER BY b.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

--
-- Name: match_document_sections(public.halfvec, double precision, integer, bigint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.match_document_sections(query_embedding public.halfvec, match_threshold double precision, match_count integer, filter_municipality_id bigint DEFAULT NULL::bigint) RETURNS TABLE(id bigint, document_id bigint, agenda_item_id bigint, section_title text, section_text text, section_order integer, similarity double precision)
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
BEGIN
  RETURN QUERY
  SELECT
    ds.id,
    ds.document_id,
    ds.agenda_item_id,
    ds.section_title,
    ds.section_text,
    ds.section_order,
    1 - (ds.embedding <=> query_embedding) AS similarity
  FROM document_sections ds
  WHERE (filter_municipality_id IS NULL OR ds.municipality_id = filter_municipality_id)
    AND 1 - (ds.embedding <=> query_embedding) > match_threshold
  ORDER BY ds.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

--
-- Name: match_key_statements(public.halfvec, double precision, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.match_key_statements(query_embedding public.halfvec, match_threshold double precision, match_count integer) RETURNS TABLE(id bigint, meeting_id bigint, agenda_item_id bigint, speaker_name text, statement_type text, statement_text text, context text, similarity double precision)
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
BEGIN
  RETURN QUERY
  SELECT
    ks.id, ks.meeting_id, ks.agenda_item_id, ks.speaker_name,
    ks.statement_type, ks.statement_text, ks.context,
    1 - (ks.embedding <=> query_embedding) AS similarity
  FROM key_statements ks
  WHERE (ks.evidence_kind IS NULL OR ks.evidence_kind='transcript')
    AND 1 - (ks.embedding <=> query_embedding) > match_threshold
  ORDER BY ks.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

--
-- Name: FUNCTION match_key_statements(query_embedding public.halfvec, match_threshold double precision, match_count integer); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.match_key_statements(query_embedding public.halfvec, match_threshold double precision, match_count integer) IS 'Semantic similarity search for key statements.';

--
-- Name: match_key_statements(public.halfvec, double precision, integer, bigint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.match_key_statements(query_embedding public.halfvec, match_threshold double precision, match_count integer, filter_municipality_id bigint DEFAULT NULL::bigint) RETURNS TABLE(id bigint, meeting_id bigint, agenda_item_id bigint, speaker_name text, statement_type text, statement_text text, context text, similarity double precision)
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
BEGIN
  RETURN QUERY
  SELECT
    ks.id, ks.meeting_id, ks.agenda_item_id, ks.speaker_name,
    ks.statement_type, ks.statement_text, ks.context,
    1 - (ks.embedding <=> query_embedding) AS similarity
  FROM key_statements ks
  WHERE (ks.evidence_kind IS NULL OR ks.evidence_kind='transcript')
    AND 1 - (ks.embedding <=> query_embedding) > match_threshold
    AND (filter_municipality_id IS NULL OR ks.municipality_id = filter_municipality_id)
  ORDER BY ks.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

--
-- Name: match_key_statements_by_person(public.halfvec, bigint, double precision, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.match_key_statements_by_person(query_embedding public.halfvec, filter_person_id bigint, match_threshold double precision, match_count integer) RETURNS TABLE(id bigint, meeting_id bigint, agenda_item_id bigint, speaker_name text, statement_type text, statement_text text, context text, similarity double precision)
    LANGUAGE sql STABLE
    SET search_path TO 'public'
    AS $$
  SELECT ks.id, ks.meeting_id, ks.agenda_item_id, ks.speaker_name,
         ks.statement_type, ks.statement_text, ks.context,
         1 - (ks.embedding <=> query_embedding) AS similarity
  FROM key_statements ks
  WHERE (ks.evidence_kind IS NULL OR ks.evidence_kind='transcript')
    AND ks.person_id = filter_person_id
    AND ks.embedding IS NOT NULL
    AND 1 - (ks.embedding <=> query_embedding) > match_threshold
  ORDER BY ks.embedding <=> query_embedding
  LIMIT match_count;
$$;

--
-- Name: match_matters(public.halfvec, double precision, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.match_matters(query_embedding public.halfvec, match_threshold double precision, match_count integer) RETURNS TABLE(id bigint, title text, plain_english_summary text, similarity double precision)
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
BEGIN
  RETURN QUERY
  SELECT
    ma.id, ma.title, ma.plain_english_summary,
    1 - (ma.embedding <=> query_embedding) AS similarity
  FROM matters ma
  WHERE 1 - (ma.embedding <=> query_embedding) > match_threshold
  ORDER BY ma.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

--
-- Name: FUNCTION match_matters(query_embedding public.halfvec, match_threshold double precision, match_count integer); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.match_matters(query_embedding public.halfvec, match_threshold double precision, match_count integer) IS 'Semantic similarity search for matters.';

--
-- Name: match_matters(public.halfvec, double precision, integer, bigint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.match_matters(query_embedding public.halfvec, match_threshold double precision, match_count integer, filter_municipality_id bigint DEFAULT NULL::bigint) RETURNS TABLE(id bigint, title text, plain_english_summary text, similarity double precision)
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
BEGIN
  RETURN QUERY
  SELECT
    ma.id, ma.title, ma.plain_english_summary,
    1 - (ma.embedding <=> query_embedding) AS similarity
  FROM matters ma
  WHERE 1 - (ma.embedding <=> query_embedding) > match_threshold
    AND (filter_municipality_id IS NULL OR ma.municipality_id = filter_municipality_id)
  ORDER BY ma.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

--
-- Name: match_motions(public.halfvec, double precision, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.match_motions(query_embedding public.halfvec, match_threshold double precision, match_count integer) RETURNS TABLE(id bigint, meeting_id bigint, agenda_item_id bigint, text_content text, mover text, seconder text, result text, similarity double precision)
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
BEGIN
  RETURN QUERY
  SELECT
    m.id, m.meeting_id, m.agenda_item_id, m.text_content,
    m.mover, m.seconder, m.result,
    1 - (m.embedding <=> query_embedding) AS similarity
  FROM motions m
  WHERE 1 - (m.embedding <=> query_embedding) > match_threshold
  ORDER BY m.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

--
-- Name: FUNCTION match_motions(query_embedding public.halfvec, match_threshold double precision, match_count integer); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.match_motions(query_embedding public.halfvec, match_threshold double precision, match_count integer) IS 'Semantic similarity search for motions.';

--
-- Name: match_motions(public.halfvec, double precision, integer, bigint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.match_motions(query_embedding public.halfvec, match_threshold double precision, match_count integer, filter_municipality_id bigint DEFAULT NULL::bigint) RETURNS TABLE(id bigint, meeting_id bigint, agenda_item_id bigint, text_content text, mover text, seconder text, result text, similarity double precision)
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
BEGIN
  RETURN QUERY
  SELECT
    m.id, m.meeting_id, m.agenda_item_id, m.text_content,
    m.mover, m.seconder, m.result,
    1 - (m.embedding <=> query_embedding) AS similarity
  FROM motions m
  JOIN meetings mt ON mt.id = m.meeting_id
  WHERE 1 - (m.embedding <=> query_embedding) > match_threshold
    AND (filter_municipality_id IS NULL OR mt.municipality_id = filter_municipality_id)
  ORDER BY m.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

--
-- Name: match_motions_by_person(public.halfvec, bigint, double precision, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.match_motions_by_person(query_embedding public.halfvec, filter_person_id bigint, match_threshold double precision, match_count integer) RETURNS TABLE(id bigint, meeting_id bigint, text_content text, result text, vote text, similarity double precision)
    LANGUAGE sql STABLE
    SET search_path TO 'public'
    AS $$
  SELECT m.id, m.meeting_id, m.text_content, m.result, v.vote,
         1 - (m.embedding <=> query_embedding) AS similarity
  FROM motions m
  JOIN votes v ON v.motion_id = m.id AND v.person_id = filter_person_id
  WHERE m.embedding IS NOT NULL
    AND 1 - (m.embedding <=> query_embedding) > match_threshold
  ORDER BY m.embedding <=> query_embedding
  LIMIT match_count;
$$;

--
-- Name: match_review_examples(public.halfvec, text, text, text, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.match_review_examples(query_embedding public.halfvec, kind text, problem_type text, verdict_type text, k integer) RETURNS TABLE(id bigint, entry_text text, reason text, verdict text, note text, similarity double precision)
    LANGUAGE sql STABLE
    AS $$
  SELECT e.id, e.entry_text, e.reason, e.verdict, e.note,
         CASE WHEN query_embedding IS NULL OR e.embedding IS NULL THEN 0 ELSE 1 - (e.embedding <=> query_embedding) END
  FROM review_examples e
  WHERE e.problem = problem_type AND e.verdict = verdict_type AND (kind IS NULL OR e.page_kind = kind)
  ORDER BY CASE WHEN query_embedding IS NULL OR e.embedding IS NULL THEN 1 ELSE 0 END,
           e.embedding <=> query_embedding, e.created_at DESC
  LIMIT k
$$;

--
-- Name: matter_root(bigint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.matter_root(p_id bigint) RETURNS bigint
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT COALESCE((SELECT merged_into FROM matters WHERE id = p_id), p_id)
$$;

--
-- Name: matter_slug_base(text, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.matter_slug_base(title text, meta jsonb) RETURNS text
    LANGUAGE plpgsql IMMUTABLE
    AS $_$
DECLARE
  src text := nullif(trim(meta->>'display_title'), '');
  base text;
BEGIN
  IF src IS NULL THEN
    src := COALESCE(title, '');
    -- Stage / procedural parentheticals: "(FIRST, SECOND AND THIRD READINGS)",
    -- "(ADOPTION)", "(Background report attached)", ...
    src := regexp_replace(
      src,
      '\s*\(\s*(first|second|third|final|1st|2nd|3rd|three|adoption|adopt|reading|readings|background|staff report|report attached|rescind|reconsideration)[^)]*\)',
      '', 'gi');
    -- Trailing stage suffixes: "... - Adoption", "... — First Reading"
    src := regexp_replace(
      src,
      '\s*[-–—:]\s*(adoption|readings?|(first|second|third|final)( (and|&|,) ?(second|third))*( and third)? readings?)\s*$',
      '', 'gi');
  END IF;
  base := public.generate_slug_capped(src, 60);
  IF base IS NULL OR base = '' THEN base := 'matter'; END IF;
  -- Never all digits: the web app treats all-digit params as legacy ids.
  IF base ~ '^[0-9]+$' THEN base := 'matter-' || base; END IF;
  RETURN base;
END;
$_$;

--
-- Name: merge_matters(bigint, bigint[], text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.merge_matters(p_canonical bigint, p_aliases bigint[], p_reason text, p_by text DEFAULT NULL::text) RETURNS jsonb
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $_$
DECLARE
  v_new bigint[];
  v_aliases bigint[];
  v_all bigint[];
  v_items bigint[];
  v_moved jsonb := '{}'::jsonb;
  v_removed jsonb := '{}'::jsonb;
  v_notes jsonb := '[]'::jsonb;
  v_ids bigint[];
  v_rows jsonb;
  v_bylaws bigint[];
  v_canonical_bylaw bigint;
  v_slug text;
  r record;
BEGIN
  IF p_canonical IS NULL THEN RAISE EXCEPTION 'merge_matters: no canonical topic'; END IF;
  PERFORM 1 FROM matters WHERE id = p_canonical FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'merge_matters: topic % does not exist', p_canonical; END IF;
  IF (SELECT merged_into FROM matters WHERE id = p_canonical) IS NOT NULL THEN
    RAISE EXCEPTION 'merge_matters: topic % is itself merged into %', p_canonical, (SELECT merged_into FROM matters WHERE id = p_canonical);
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(coalesce(p_aliases, '{}')) a WHERE NOT EXISTS (SELECT 1 FROM matters WHERE id = a)) THEN
    RAISE EXCEPTION 'merge_matters: unknown topic in %', p_aliases;
  END IF;

  -- Newly merged: the given topics and anything merged into them, unless already merged into this canonical.
  SELECT coalesce(array_agg(id ORDER BY id), '{}') INTO v_new FROM matters
   WHERE id <> p_canonical AND (id = ANY(coalesce(p_aliases, '{}')) OR merged_into = ANY(coalesce(p_aliases, '{}')))
     AND merged_into IS DISTINCT FROM p_canonical;
  PERFORM 1 FROM matters WHERE id = ANY(v_new) FOR UPDATE;
  UPDATE matters SET merged_into = p_canonical WHERE id = ANY(v_new);
  SELECT coalesce(array_agg(id ORDER BY id), '{}') INTO v_aliases FROM matters WHERE merged_into = p_canonical;
  v_all := v_aliases || p_canonical;

  -- Agenda items, and staff locks that would refile an item under an alias at the next ingest.
  WITH u AS (UPDATE agenda_items SET matter_id = p_canonical WHERE matter_id = ANY(v_aliases) RETURNING id)
  SELECT coalesce(array_agg(id ORDER BY id), '{}') INTO v_items FROM u;
  v_moved := v_moved || jsonb_build_object('agenda_items', to_jsonb(v_items));
  WITH u AS (
    UPDATE agenda_items SET meta = jsonb_set(meta, '{staff_matter,matter_id}', to_jsonb(p_canonical))
     WHERE meta->'staff_matter'->>'matter_id' ~ '^[0-9]+$' AND (meta->'staff_matter'->>'matter_id')::bigint = ANY(v_aliases)
    RETURNING id)
  SELECT coalesce(array_agg(id ORDER BY id), '{}') INTO v_ids FROM u;
  v_moved := v_moved || jsonb_build_object('staff_locks', to_jsonb(v_ids));

  -- Comments record which topics they were about by topic id (meta.participation.about_matters): re-key aliases.
  WITH u AS (
    UPDATE agenda_items SET meta = jsonb_set(meta, '{participation,about_matters}', rekey_about_matters(meta->'participation'->'about_matters'))
     WHERE jsonb_typeof(meta->'participation'->'about_matters') = 'object'
       AND (meta->'participation'->'about_matters') ?| (SELECT array_agg(a::text) FROM unnest(v_aliases) a)
    RETURNING id)
  SELECT coalesce(array_agg(id ORDER BY id), '{}') INTO v_ids FROM u;
  v_moved := v_moved || jsonb_build_object('about_matters', to_jsonb(v_ids));

  -- Mentions: drop ones of items the canonical now owns, and duplicates per item; move the rest.
  WITH m AS (
    SELECT l.id, l.matter_id, l.agenda_item_id, l.review, l.quote, l.hidden,
           (l.matter_id = ANY(v_aliases) OR l.agenda_item_id = ANY(v_items))
             AND EXISTS (SELECT 1 FROM agenda_items a WHERE a.id = l.agenda_item_id AND a.matter_id = p_canonical) AS owned
      FROM matter_links l WHERE l.kind = 'mention' AND l.matter_id = ANY(v_all)
  ), ranked AS (
    SELECT id, matter_id, owned, row_number() OVER (PARTITION BY agenda_item_id ORDER BY
             (review IN ('removed', 'rejected')) DESC NULLS LAST, (review = 'accepted') DESC NULLS LAST,
             (matter_id = p_canonical) DESC, (hidden IS NOT TRUE) DESC, (quote IS NOT NULL) DESC, id) AS rn
      FROM m WHERE NOT owned
  ), doomed AS (
    SELECT id FROM m WHERE owned UNION SELECT id FROM ranked WHERE rn > 1
  ), d AS (DELETE FROM matter_links WHERE id IN (SELECT id FROM doomed) RETURNING to_jsonb(matter_links.*) AS row)
  SELECT coalesce(jsonb_agg(row), '[]') INTO v_rows FROM d;
  v_removed := v_removed || jsonb_build_object('mentions', v_rows);
  WITH u AS (UPDATE matter_links SET matter_id = p_canonical WHERE kind = 'mention' AND matter_id = ANY(v_aliases) RETURNING id)
  SELECT coalesce(array_agg(id ORDER BY id), '{}') INTO v_ids FROM u;
  v_moved := v_moved || jsonb_build_object('mentions', to_jsonb(v_ids));

  -- Related-topic links: ends resolved; self-links dropped; one row per pair, the reviewed one kept.
  WITH l AS (
    SELECT id, review, matter_id, related_matter_id, matter_root(matter_id) AS a, matter_root(related_matter_id) AS b
      FROM matter_links WHERE kind = 'related_matter' AND (matter_id = ANY(v_all) OR related_matter_id = ANY(v_all))
  ), ranked AS (
    SELECT id, a, b, row_number() OVER (PARTITION BY least(a, b), greatest(a, b) ORDER BY
             (review IS NOT NULL) DESC, (matter_id = a AND related_matter_id = b) DESC, id) AS rn
      FROM l WHERE a <> b
  ), doomed AS (
    SELECT id FROM l WHERE a = b UNION SELECT id FROM ranked WHERE rn > 1
  ), d AS (DELETE FROM matter_links WHERE id IN (SELECT id FROM doomed) RETURNING to_jsonb(matter_links.*) AS row)
  SELECT coalesce(jsonb_agg(row), '[]') INTO v_rows FROM d;
  v_removed := v_removed || jsonb_build_object('related', v_rows);
  WITH u AS (
    UPDATE matter_links SET matter_id = matter_root(matter_id), related_matter_id = matter_root(related_matter_id)
     WHERE kind = 'related_matter' AND (matter_id = ANY(v_aliases) OR related_matter_id = ANY(v_aliases))
    RETURNING id)
  SELECT coalesce(array_agg(id ORDER BY id), '{}') INTO v_ids FROM u;
  v_moved := v_moved || jsonb_build_object('related', to_jsonb(v_ids));

  -- Property links: per-item rows simply move; per-topic rows keep one per property.
  WITH ranked AS (
    SELECT id, row_number() OVER (PARTITION BY property_id ORDER BY (matter_id = p_canonical) DESC, (source = 'admin') DESC, id) AS rn
      FROM property_links WHERE agenda_item_id IS NULL AND matter_id = ANY(v_all)
  ), d AS (DELETE FROM property_links WHERE id IN (SELECT id FROM ranked WHERE rn > 1) RETURNING to_jsonb(property_links.*) AS row)
  SELECT coalesce(jsonb_agg(row), '[]') INTO v_rows FROM d;
  v_removed := v_removed || jsonb_build_object('property_links', v_rows);
  WITH u AS (UPDATE property_links SET matter_id = p_canonical WHERE matter_id = ANY(v_aliases) RETURNING id)
  SELECT coalesce(array_agg(id ORDER BY id), '{}') INTO v_ids FROM u;
  v_moved := v_moved || jsonb_build_object('property_links', to_jsonb(v_ids));

  -- Report mentions: one per (report, page).
  WITH ranked AS (
    SELECT id, row_number() OVER (PARTITION BY report_id, page ORDER BY
             (review IN ('removed', 'rejected')) DESC NULLS LAST, (review = 'accepted') DESC NULLS LAST,
             (matter_id = p_canonical) DESC, (hidden IS NOT TRUE) DESC, (quote IS NOT NULL) DESC, id) AS rn
      FROM matter_report_mentions WHERE matter_id = ANY(v_all)
  ), d AS (DELETE FROM matter_report_mentions WHERE id IN (SELECT id FROM ranked WHERE rn > 1) RETURNING to_jsonb(matter_report_mentions.*) AS row)
  SELECT coalesce(jsonb_agg(row), '[]') INTO v_rows FROM d;
  v_removed := v_removed || jsonb_build_object('report_mentions', v_rows);
  WITH u AS (UPDATE matter_report_mentions SET matter_id = p_canonical WHERE matter_id = ANY(v_aliases) RETURNING id)
  SELECT coalesce(array_agg(id ORDER BY id), '{}') INTO v_ids FROM u;
  v_moved := v_moved || jsonb_build_object('report_mentions', to_jsonb(v_ids));

  -- Evidence: one per (item, section, type).
  WITH ranked AS (
    SELECT id, row_number() OVER (PARTITION BY coalesce(agenda_item_id, 0), coalesce(document_section_id, 0), evidence_type
             ORDER BY (review IS NOT NULL) DESC, (matter_id = p_canonical) DESC, id) AS rn
      FROM matter_evidence WHERE matter_id = ANY(v_all)
  ), d AS (DELETE FROM matter_evidence WHERE id IN (SELECT id FROM ranked WHERE rn > 1) RETURNING to_jsonb(matter_evidence.*) AS row)
  SELECT coalesce(jsonb_agg(row), '[]') INTO v_rows FROM d;
  v_removed := v_removed || jsonb_build_object('evidence', v_rows);
  WITH u AS (UPDATE matter_evidence SET matter_id = p_canonical WHERE matter_id = ANY(v_aliases) RETURNING id)
  SELECT coalesce(array_agg(id ORDER BY id), '{}') INTO v_ids FROM u;
  v_moved := v_moved || jsonb_build_object('evidence', to_jsonb(v_ids));

  -- Subscriptions: one per person and target, so nobody gets the same alert twice.
  WITH ranked AS (
    SELECT id, row_number() OVER (PARTITION BY user_id, type, topic_id, person_id, neighborhood, keyword
             ORDER BY (matter_id = p_canonical) DESC, id) AS rn
      FROM subscriptions WHERE matter_id = ANY(v_all)
  ), d AS (DELETE FROM subscriptions WHERE id IN (SELECT id FROM ranked WHERE rn > 1) RETURNING jsonb_build_object('id', id, 'user_id', user_id, 'matter_id', matter_id) AS row)
  SELECT coalesce(jsonb_agg(row), '[]') INTO v_rows FROM d;
  v_removed := v_removed || jsonb_build_object('subscriptions', v_rows);
  WITH u AS (UPDATE subscriptions SET matter_id = p_canonical WHERE matter_id = ANY(v_aliases) RETURNING id)
  SELECT coalesce(array_agg(id ORDER BY id), '{}') INTO v_ids FROM u;
  v_moved := v_moved || jsonb_build_object('subscriptions', to_jsonb(v_ids));

  -- Page reviews keyed by an alias's address move to the canonical's, unless it already has one.
  SELECT slug INTO v_slug FROM matters WHERE id = p_canonical;
  v_ids := '{}';
  FOR r IN SELECT p.path FROM page_reviews p JOIN matters m ON p.path = '/matters/' || m.slug
            WHERE m.id = ANY(v_aliases) ORDER BY p.reviewed_at DESC NULLS LAST, p.path LOOP
    IF v_slug IS NOT NULL AND NOT EXISTS (SELECT 1 FROM page_reviews WHERE path = '/matters/' || v_slug) THEN
      UPDATE page_reviews SET path = '/matters/' || v_slug WHERE path = r.path;
      v_notes := v_notes || jsonb_build_object('page_review_moved', r.path);
    ELSE
      v_notes := v_notes || jsonb_build_object('page_review_left', r.path);
    END IF;
  END LOOP;

  -- The bylaw: an alias's goes across when the canonical has none and there's only one; otherwise noted for review.
  SELECT bylaw_id INTO v_canonical_bylaw FROM matters WHERE id = p_canonical;
  SELECT coalesce(array_agg(DISTINCT bylaw_id), '{}') INTO v_bylaws FROM matters
   WHERE id = ANY(v_aliases) AND bylaw_id IS NOT NULL AND bylaw_id IS DISTINCT FROM v_canonical_bylaw;
  IF v_canonical_bylaw IS NULL AND cardinality(v_bylaws) = 1 THEN
    UPDATE matters SET bylaw_id = v_bylaws[1] WHERE id = p_canonical;
    v_notes := v_notes || jsonb_build_object('bylaw_copied', v_bylaws[1]);
  ELSIF cardinality(v_bylaws) > 0 THEN
    v_notes := v_notes || jsonb_build_object('bylaws_to_review', to_jsonb(v_bylaws), 'canonical_bylaw', v_canonical_bylaw);
  END IF;

  -- A map location only an alias had goes across.
  UPDATE matters c SET geo_location = (SELECT geo_location FROM matters WHERE id = ANY(v_aliases) AND geo_location IS NOT NULL ORDER BY id LIMIT 1)
   WHERE c.id = p_canonical AND c.geo_location IS NULL;

  -- The canonical spans everyone's dates; aliases keep their notes but lose public text.
  UPDATE matters c SET
    first_seen = (SELECT min(first_seen) FROM matters WHERE id = ANY(v_all)),
    last_seen = (SELECT max(last_seen) FROM matters WHERE id = ANY(v_all)),
    meta = coalesce(c.meta, '{}'::jsonb) - 'canonical_matter_id' - 'merged_matter_ids'
  WHERE c.id = p_canonical;
  UPDATE matters a SET
    plain_english_summary = NULL,
    embedding = NULL,
    meta = (coalesce(a.meta, '{}'::jsonb) - 'merged_matter_ids' - 'canonical_matter_id' - 'display_title' - 'status_line')
           || CASE WHEN a.id = ANY(v_new) OR NOT (coalesce(a.meta, '{}'::jsonb) ? 'merge_reason')
                   THEN jsonb_build_object('merge_reason', coalesce(p_reason, 'merged')) ELSE '{}'::jsonb END
  WHERE a.id = ANY(v_aliases);

  INSERT INTO matter_merges (canonical_id, alias_ids, reason, merged_by, moved, removed, notes)
  VALUES (p_canonical, v_aliases, p_reason, p_by, v_moved, v_removed, v_notes);

  RETURN jsonb_build_object(
    'canonical', p_canonical, 'aliases', to_jsonb(v_aliases), 'newly_merged', to_jsonb(v_new),
    'moved', (SELECT jsonb_object_agg(key, jsonb_array_length(value)) FROM jsonb_each(v_moved)),
    'removed', (SELECT jsonb_object_agg(key, jsonb_array_length(value)) FROM jsonb_each(v_removed)),
    'notes', v_notes);
END $_$;

--
-- Name: normalize_category_to_topic(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.normalize_category_to_topic(cat text) RETURNS text
    LANGUAGE plpgsql IMMUTABLE
    SET search_path TO 'public'
    AS $$
BEGIN
  IF cat IS NULL THEN RETURN 'General'; END IF;

  IF cat ILIKE ANY(ARRAY['%bylaw%', '%zoning%', '%rezoning%', '%regulatory%', '%legislat%'])
    THEN RETURN 'Bylaw';
  ELSIF cat ILIKE ANY(ARRAY['%develop%', '%planning%', '%land use%', '%permit%', '%ocp%', '%housing%', '%heritage%', '%subdivis%'])
    THEN RETURN 'Development';
  ELSIF cat ILIKE ANY(ARRAY['%environ%', '%park%', '%climate%', '%sustain%', '%trail%', '%tree%', '%conservation%', '%recreation%'])
    THEN RETURN 'Environment';
  ELSIF cat ILIKE ANY(ARRAY['%financ%', '%budget%', '%tax%', '%grant%', '%capital%', '%debt%', '%fund%'])
    THEN RETURN 'Finance';
  ELSIF cat ILIKE ANY(ARRAY['%transport%', '%traffic%', '%road%', '%transit%', '%cycl%', '%pedestr%', '%infrastruc%', '%engineer%'])
    THEN RETURN 'Transportation';
  ELSIF cat ILIKE ANY(ARRAY['%safe%', '%polic%', '%fire%', '%protect%', '%emergency%', '%rcmp%', '%enforcement%'])
    THEN RETURN 'Public Safety';
  ELSIF cat ILIKE ANY(ARRAY['%admin%', '%governance%', '%appoint%', '%committee%', '%procedur%', '%minutes%', '%agenda%', '%adjournm%', '%closed%', '%routine%', '%consent%'])
    THEN RETURN 'Administration';
  ELSE
    RETURN 'General';
  END IF;
END;
$$;

--
-- Name: page_hidden(text, bigint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.page_hidden(p_table text, p_id bigint) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT EXISTS (SELECT 1 FROM public.hidden_pages WHERE record_table = p_table AND record_id = p_id);
$$;

--
-- Name: property_privacy_flags(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.property_privacy_flags() RETURNS TABLE(id bigint, hide boolean)
    LANGUAGE sql STABLE
    SET search_path TO 'public', 'pg_temp'
    AS $$
  SELECT p.id,
    p.civic_number <> ''
    AND NOT EXISTS (
      SELECT 1 FROM property_links l
      LEFT JOIN agenda_items ai ON ai.id = l.agenda_item_id
      LEFT JOIN matters m ON m.id = l.matter_id
      WHERE l.property_id = p.id AND NOT l.hidden
        AND (l.matter_id IS NULL OR (m.merged_into IS NULL AND coalesce(m.meta->>'hidden', 'false') <> 'true'))
        AND (l.agenda_item_id IS NULL OR NOT is_public_input_item(ai.title, ai.category)))
    AND EXISTS (
      SELECT 1 FROM property_links l JOIN agenda_items ai ON ai.id = l.agenda_item_id
      WHERE l.property_id = p.id AND is_public_input_item(ai.title, ai.category))
  FROM properties p
$$;

--
-- Name: public_participant_appearances(date, bigint, bigint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.public_participant_appearances(p_today date, p_municipality_id bigint DEFAULT NULL::bigint, p_person_id bigint DEFAULT NULL::bigint) RETURNS jsonb
    LANGUAGE sql STABLE
    SET search_path TO 'public'
    SET extra_float_digits TO '3'
    AS $$
  WITH segments AS (
    -- A range on the index's leading column (all identified speakers, or exactly one) rather than
    -- "p_person_id IS NULL OR person_id = p_person_id": a cached generic plan can still use it, and the index
    -- order (person, meeting, agenda item, id) feeds the grouping below without a sort.
    SELECT id, person_id, meeting_id, agenda_item_id, start_time, end_time
      FROM transcript_segments
     WHERE person_id BETWEEN coalesce(p_person_id, -9223372036854775808) AND coalesce(p_person_id, 9223372036854775807)
  ), appearances AS (
    -- Meeting date and municipality are per meeting, so they can filter whole groups afterwards.
    SELECT person_id, meeting_id, agenda_item_id,
           sum(end_time - start_time ORDER BY id) AS seconds,
           count(*) AS segments,
           min(start_time) AS first_start,
           min(id) AS first_segment_id
      FROM segments
     -- The web code skips zero-length, reversed and non-finite segments entirely (in Postgres NaN sorts above
     -- Infinity, so the upper bound excludes both).
     WHERE end_time > start_time
       AND end_time - start_time < 'Infinity'::double precision
     GROUP BY person_id, meeting_id, agenda_item_id
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'person_id', a.person_id,
           'meeting_id', a.meeting_id,
           'agenda_item_id', a.agenda_item_id,
           'seconds', a.seconds,
           'segments', a.segments,
           'first_start', a.first_start,
           'meeting_slug', m.slug,
           'meeting_title', m.title,
           'meeting_date', m.meeting_date,
           'municipality_id', m.municipality_id,
           'organization_id', m.organization_id,
           'agenda_title', ai.title,
           'category', ai.category
         ) ORDER BY a.first_segment_id), '[]'::jsonb)
    FROM appearances a
    JOIN meetings m ON m.id = a.meeting_id
    LEFT JOIN agenda_items ai ON ai.id = a.agenda_item_id
   WHERE m.meeting_date <= p_today
     AND (p_municipality_id IS NULL OR m.municipality_id = p_municipality_id);
$$;

--
-- Name: publish_source_bound_key_statement(text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.publish_source_bound_key_statement(p_input_canonical_json text, p_input_sha256 text) RETURNS jsonb
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public'
    SET "TimeZone" TO 'UTC'
    AS $_$
DECLARE
    v jsonb;
    s jsonb;
    raw jsonb;
    expected jsonb;
    projected jsonb;
    proof jsonb;
    prior jsonb;
    allproofs jsonb;
    v_meta jsonb;
    source_ids jsonb := '[]'::jsonb;
    receipt_ids jsonb;
    receipt_hashes jsonb := '[]'::jsonb;
    item public.transcript_segments%ROWTYPE;
    receipt public.transcript_identity_evidence%ROWTYPE;
    v_statement public.key_statements%ROWTYPE;
    v_meeting public.meetings%ROWTYPE;
    v_agenda public.agenda_items%ROWTYPE;
    v_meeting_id bigint;
    v_agenda_id bigint;
    v_person_id bigint;
    v_name text;
    raw_label text;
    source_sha text;
    quote_sha text;
    identity_key text;
    joined text := '';
    normalized_source text;
    normalized_quote text;
    first_start double precision;
    last_index bigint;
    idx bigint;
    starts double precision;
    ends double precision;
    sid bigint;
    rid uuid;
    canonical_count integer;
    matched boolean;
    ids bigint[] := '{}';
BEGIN
    IF p_input_sha256 IS DISTINCT FROM encode(sha256(convert_to(p_input_canonical_json,'UTF8')),'hex') THEN
        RAISE EXCEPTION 'statement canonical input hash mismatch';
    END IF;
    v := p_input_canonical_json::jsonb;
    IF jsonb_typeof(v) IS DISTINCT FROM 'object'
        OR v->>'validator_version' IS DISTINCT FROM 'source-bound-key-statements-v2'
        OR NOT coalesce(v->>'validator_sha256' ~ '^[0-9a-f]{64}$',false) THEN
        RAISE EXCEPTION 'versioned machine validator input required';
    END IF;
    v_meeting_id := (v->>'meeting_id')::bigint;
    v_agenda_id := (v->>'agenda_item_id')::bigint;
    SELECT * INTO v_meeting FROM public.meetings WHERE id=v_meeting_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'statement meeting unavailable'; END IF;
    SELECT * INTO v_agenda FROM public.agenda_items WHERE id=v_agenda_id FOR SHARE;
    IF NOT FOUND OR v_agenda.meeting_id IS DISTINCT FROM v_meeting_id THEN
        RAISE EXCEPTION 'statement agenda/meeting mismatch';
    END IF;
    s := v->'statement';
    source_sha := v->>'transcript_source_sha256';
    v_person_id := (s->>'person_id')::bigint;
    IF jsonb_typeof(s) IS DISTINCT FROM 'object'
        OR NOT coalesce(source_sha ~ '^[0-9a-f]{64}$',false)
        OR jsonb_typeof(s->'statement_text')IS DISTINCT FROM'string'
        OR coalesce(trim(s->>'statement_text'),'')=''
        OR coalesce(s->>'statement_type','') NOT IN ('claim','proposal','objection','recommendation','financial','public_input')
        OR NOT coalesce((v->>'source_segment_count')::bigint>0,false)
        OR jsonb_typeof(v->'raw_segments') IS DISTINCT FROM 'array'
        OR jsonb_array_length(v->'raw_segments')=0
        OR jsonb_typeof(v->'expected_segments') IS DISTINCT FROM 'array'
        OR jsonb_array_length(v->'expected_segments')=0 THEN
        RAISE EXCEPTION 'bounded original speech and expected row tuples required';
    END IF;
    -- Bound source-array indexes explicitly; DB row IDs are never array indexes.
    FOR raw IN SELECT value FROM jsonb_array_elements(v->'raw_segments') LOOP
        idx := (raw->>'source_index')::bigint;
        starts := (raw->>'start')::double precision;
        ends := (raw->>'end')::double precision;
        sid := (raw->>'segment_id')::bigint;
        IF idx IS NULL OR starts IS NULL OR ends IS NULL OR sid IS NULL OR idx<0 OR idx>=(v->>'source_segment_count')::bigint OR (last_index IS NOT NULL AND idx<>last_index+1)
            OR starts<0 OR NOT starts<ends OR starts IN ('Infinity'::float8,'-Infinity'::float8,'NaN'::float8)
            OR ends IN ('Infinity'::float8,'-Infinity'::float8,'NaN'::float8)
            OR coalesce(trim(raw->>'text'),'')=''
            OR jsonb_typeof(raw->'speaker') IS DISTINCT FROM 'string' THEN
            RAISE EXCEPTION 'invalid/noncontiguous original speech tuple';
        END IF;
        IF last_index IS NULL THEN raw_label:=raw->>'speaker'; first_start:=starts; END IF;
        IF raw->>'speaker' IS DISTINCT FROM raw_label THEN RAISE EXCEPTION 'quote crosses raw speakers'; END IF;
        SELECT * INTO item FROM public.transcript_segments WHERE id=sid FOR SHARE;
        IF NOT FOUND OR item.meeting_id IS DISTINCT FROM v_meeting_id
            OR NOT(item.start_time<=starts AND starts<ends AND ends<=item.end_time)
            OR strpos(regexp_replace(item.text_content,'\s+',' ','g'),regexp_replace(raw->>'text','\s+',' ','g'))=0 THEN
            RAISE EXCEPTION USING ERRCODE='40001',MESSAGE='statement current source tuple changed';
        END IF;
        SELECT value INTO expected FROM jsonb_array_elements(v->'expected_segments') WHERE (value->>'id')::bigint=sid;
        IF NOT FOUND OR (SELECT count(*)FROM jsonb_array_elements(v->'expected_segments')WHERE(value->>'id')::bigint=sid)<>1 THEN
            RAISE EXCEPTION 'unique complete expected source tuple required';
        END IF;
        projected := jsonb_build_object('id',item.id,'meeting_id',item.meeting_id,'person_id',item.person_id,
            'speaker_name',item.speaker_name,'start_time',item.start_time,'end_time',item.end_time,'text_content',item.text_content);
        IF projected IS DISTINCT FROM expected THEN
            RAISE EXCEPTION USING ERRCODE='40001',MESSAGE='statement source row compare-and-swap failed';
        END IF;
        -- A caller cannot choose the first of several matching persisted tuples.
        IF (SELECT count(*)FROM public.transcript_segments t WHERE t.meeting_id=v_meeting_id
            AND t.start_time<=starts AND ends<=t.end_time
            AND strpos(regexp_replace(t.text_content,'\s+',' ','g'),regexp_replace(raw->>'text','\s+',' ','g'))>0)<>1 THEN
            RAISE EXCEPTION 'ambiguous persisted source tuple';
        END IF;
        IF NOT sid=ANY(ids) THEN ids:=array_append(ids,sid);source_ids:=source_ids||jsonb_build_array(sid); END IF;
        joined:=joined||' '||(raw->>'text');last_index:=idx;
    END LOOP;
    normalized_source:=trim(regexp_replace(joined,'\s+',' ','g'));
    normalized_quote:=trim(regexp_replace(s->>'statement_text','\s+',' ','g'));
    IF (SELECT count(*)FROM jsonb_array_elements(v->'expected_segments'))<>cardinality(ids)
        OR s->'source_segment_ids' IS DISTINCT FROM source_ids
        OR (s->>'start_time')::double precision IS DISTINCT FROM first_start
        OR s->>'statement_text'IS DISTINCT FROM normalized_quote
        OR NOT EXISTS(SELECT 1 FROM generate_series(1,length(normalized_source)-length(normalized_quote)+1)AS g(pos)
            WHERE substring(normalized_source FROM g.pos FOR length(normalized_quote))=normalized_quote
            AND(left(normalized_quote,1)!~'[[:alnum:]_]'OR g.pos=1 OR substring(normalized_source FROM g.pos-1 FOR 1)!~'[[:alnum:]_]')
            AND(right(normalized_quote,1)!~'[[:alnum:]_]'OR substring(normalized_source FROM g.pos+length(normalized_quote)FOR 1)!~'[[:alnum:]_]')) THEN
        RAISE EXCEPTION 'exact whole-word quote, measured start and bound source IDs required';
    END IF;
    receipt_ids:=coalesce(v->'identity_receipt_ids','[]'::jsonb);
    IF v_person_id IS NULL THEN
        IF s->>'speaker_name' IS DISTINCT FROM (CASE WHEN raw_label ~* '^speaker_[0-9]+$' THEN raw_label ELSE 'Unidentified speaker' END) OR jsonb_array_length(receipt_ids)<>0 THEN
            RAISE EXCEPTION 'unadmitted identity must remain generically labelled and NULL';
        END IF;
    ELSE
        SELECT p.name INTO v_name FROM public.people p WHERE p.id=v_person_id FOR SHARE;
        SELECT count(*)INTO canonical_count FROM public.people p WHERE lower(trim(regexp_replace(p.name,'\s+',' ','g')))=lower(trim(regexp_replace(v_name,'\s+',' ','g')));
        IF v_name IS NULL OR v_name IS DISTINCT FROM s->>'speaker_name'OR canonical_count<>1 THEN
            RAISE EXCEPTION 'unique exact canonical speaker required';
        END IF;
        FOREACH sid IN ARRAY ids LOOP
            SELECT * INTO item FROM public.transcript_segments WHERE id=sid FOR SHARE;
            matched:=false;
            FOR rid IN SELECT value::text::uuid FROM jsonb_array_elements_text(receipt_ids) LOOP
                SELECT * INTO receipt FROM public.transcript_identity_evidence WHERE id=rid FOR SHARE;
                IF FOUND AND receipt.segment_id=sid AND receipt.meeting_id=v_meeting_id
                    AND receipt.person_id=v_person_id AND item.person_id=v_person_id
                    AND receipt.status='applied'AND receipt.reverted_at IS NULL
                    AND receipt.source_run->>'transcript_sha256'=source_sha
                    AND (receipt.source_run->>'meeting_id')::bigint=v_meeting_id
                    AND receipt.after_row @> jsonb_build_object('id',item.id,'meeting_id',item.meeting_id,
                        'person_id',item.person_id,'speaker_name',item.speaker_name,'start_time',item.start_time,
                        'end_time',item.end_time,'text_content',item.text_content) THEN
                    matched:=true;
                    receipt_hashes:=receipt_hashes||jsonb_build_array(encode(sha256(convert_to(to_jsonb(receipt)::text,'UTF8')),'hex'));
                END IF;
            END LOOP;
            IF NOT matched THEN RAISE EXCEPTION 'active exact source/row identity admission required'; END IF;
        END LOOP;
    END IF;
    quote_sha:=encode(sha256(convert_to(s->>'statement_text','UTF8')),'hex');
    identity_key:=encode(sha256(convert_to(jsonb_build_object('meeting_id',v_meeting_id,'agenda_item_id',v_agenda_id,
        'source_segment_ids',source_ids,'quote_sha256',quote_sha)::text,'UTF8')),'hex');
    v_meta:=coalesce(v_meeting.meta,'{}'::jsonb);allproofs:=coalesce(v_meta->'key_statement_evidence','{}'::jsonb);
    IF jsonb_typeof(v_meta)IS DISTINCT FROM'object'OR jsonb_typeof(allproofs)IS DISTINCT FROM'object'THEN RAISE EXCEPTION 'statement proof metadata format held'; END IF;
    prior:=allproofs->identity_key;
    IF prior IS NOT NULL THEN
        SELECT * INTO v_statement FROM public.key_statements WHERE id=(prior->>'statement_id')::bigint FOR SHARE;
        IF NOT FOUND OR v_statement.meeting_id IS DISTINCT FROM v_meeting_id OR v_statement.agenda_item_id IS DISTINCT FROM v_agenda_id
            OR to_jsonb(v_statement.source_segment_ids)IS DISTINCT FROM source_ids
            OR v_statement.statement_text IS DISTINCT FROM s->>'statement_text'
            OR v_statement.person_id IS DISTINCT FROM v_person_id OR v_statement.speaker_name IS DISTINCT FROM s->>'speaker_name'
            OR v_statement.evidence_kind IS DISTINCT FROM 'transcript'
            OR prior->>'transcript_source_sha256'IS DISTINCT FROM source_sha THEN
            RAISE EXCEPTION 'existing source statement identity changed; reviewed reconciliation required';
        END IF;
        RETURN jsonb_build_object('status','already_published','statement_id',v_statement.id,'proof_digest',identity_key);
    END IF;
    -- Legacy rows are never adopted or overwritten merely because text matches.
    IF EXISTS(SELECT 1 FROM public.key_statements k WHERE k.meeting_id=v_meeting_id
        AND k.agenda_item_id=v_agenda_id AND to_jsonb(k.source_segment_ids)=source_ids
        AND k.statement_text=s->>'statement_text')THEN RAISE EXCEPTION 'unproved legacy statement collision held'; END IF;
    INSERT INTO public.key_statements("meeting_id","agenda_item_id","speaker_name","person_id","statement_type","statement_text","context","source_segment_ids","start_time","municipality_id","evidence_kind")
        VALUES(v_meeting_id,v_agenda_id,s->>'speaker_name',v_person_id,s->>'statement_type',s->>'statement_text',s->>'context',ids,first_start,v_meeting.municipality_id,'transcript')
        RETURNING * INTO v_statement;
    proof:=jsonb_build_object('statement_id',v_statement.id,'meeting_id',v_meeting_id,'agenda_item_id',v_agenda_id,
        'transcript_source_sha256',source_sha,'source_segment_indexes',(SELECT jsonb_agg(value->'source_index')FROM jsonb_array_elements(v->'raw_segments')),
        'source_segment_ids',source_ids,'source_quote_sha256',quote_sha,'person_id',v_person_id,
        'validator_version',v->>'validator_version','validator_sha256',v->>'validator_sha256',
        'input_sha256',p_input_sha256,'identity_receipt_sha256s',receipt_hashes,'receipt_hash_format','postgres-jsonb-text-sha256-v1');
    UPDATE public.meetings SET "meta"=v_meta||jsonb_build_object('key_statement_evidence',allproofs||jsonb_build_object(identity_key,proof))WHERE id=v_meeting_id;
    RETURN jsonb_build_object('status','published','statement_id',v_statement.id,'proof_digest',identity_key);
END;
$_$;

--
-- Name: reconcile_calendar_source(bigint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.reconcile_calendar_source(p_source_meeting_id bigint) RETURNS bigint
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE source source_meetings%ROWTYPE; candidate bigint; matches bigint; siblings bigint; org_name text;
BEGIN
  SELECT * INTO STRICT source FROM source_meetings WHERE id=p_source_meeting_id FOR UPDATE;
  IF source.municipality_id<>(SELECT id FROM municipalities WHERE slug='langford') OR source.source_type<>'escribe' THEN RETURN NULL; END IF;
  IF source.ingested_meeting_id IS NOT NULL THEN
    IF NOT EXISTS(SELECT 1 FROM meetings WHERE id=source.ingested_meeting_id AND municipality_id=source.municipality_id) THEN
      RAISE EXCEPTION 'Calendar source mapping crosses municipality';
    END IF;
    RETURN source.ingested_meeting_id;
  END IF;
  org_name:=CASE WHEN source.meeting_type='Advisory Committee' THEN source.title ELSE 'Council' END;
  SELECT count(*),min(m.id) INTO matches,candidate FROM meetings m
    JOIN organizations o ON o.id=m.organization_id
    WHERE m.municipality_id=source.municipality_id AND m.calendar_source_id IS NOT NULL
      AND m.meeting_date=source.meeting_date AND m.type::text=source.meeting_type AND o.name=org_name
      AND NOT EXISTS(SELECT 1 FROM source_meetings alias WHERE alias.ingested_meeting_id=m.id
        AND alias.source_type='escribe' AND alias.id<>source.id);
  SELECT count(*) INTO siblings FROM source_meetings s WHERE s.municipality_id=source.municipality_id
    AND s.source_type='escribe' AND s.meeting_date=source.meeting_date AND s.meeting_type=source.meeting_type
    AND (source.meeting_type<>'Advisory Committee' OR s.title=source.title);
  IF matches>1 OR (matches=1 AND siblings>1) THEN
    RAISE EXCEPTION 'Ambiguous published sources for calendar placeholder; review before ingestion';
  END IF;
  IF matches=0 THEN
    IF EXISTS(SELECT 1 FROM meetings m JOIN organizations o ON o.id=m.organization_id
      JOIN source_meetings origin ON origin.id=m.calendar_source_id
      WHERE m.municipality_id=source.municipality_id AND m.type::text=source.meeting_type
        AND o.name=org_name AND abs(m.meeting_date-source.meeting_date)<=14
        AND origin.source_type='official_schedule'
        AND NOT EXISTS(SELECT 1 FROM source_meetings alias WHERE alias.ingested_meeting_id=m.id AND alias.source_type='escribe')) THEN
      RAISE EXCEPTION 'Possible calendar reschedule requires review before ingestion';
    END IF;
    RETURN NULL;
  END IF;
  PERFORM id FROM meetings WHERE id=candidate FOR UPDATE;
  UPDATE source_meetings SET ingested_meeting_id=candidate WHERE id=source.id;
  RETURN candidate;
END $$;

--
-- Name: record_email_provider_event(text, text, text, timestamp with time zone, uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.record_email_provider_event(p_event_id text, p_provider_id text, p_type text, p_at timestamp with time zone, p_message uuid, p_recipient text) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
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

--
-- Name: redirect_merged_matter(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.redirect_merged_matter() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
BEGIN
  IF NEW.matter_id IS NOT NULL THEN NEW.matter_id := matter_root(NEW.matter_id); END IF;
  RETURN NEW;
END $$;

--
-- Name: redirect_merged_matter_link(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.redirect_merged_matter_link() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
BEGIN
  NEW.matter_id := matter_root(NEW.matter_id);
  IF NEW.related_matter_id IS NOT NULL THEN
    NEW.related_matter_id := matter_root(NEW.related_matter_id);
    IF NEW.related_matter_id = NEW.matter_id THEN RETURN NULL; END IF;
  END IF;
  RETURN NEW;
END $$;

--
-- Name: refresh_property_privacy(boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.refresh_property_privacy(p_dry_run boolean DEFAULT false) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE hidden_now integer; changed integer;
BEGIN
  IF p_dry_run THEN
    SELECT count(*) FILTER (WHERE f.hide), count(*) FILTER (WHERE p.hidden IS DISTINCT FROM f.hide)
      INTO hidden_now, changed FROM property_privacy_flags() f JOIN properties p ON p.id = f.id;
  ELSE
    UPDATE properties p SET hidden = f.hide FROM property_privacy_flags() f
    WHERE f.id = p.id AND p.hidden IS DISTINCT FROM f.hide;
    GET DIAGNOSTICS changed = ROW_COUNT;
    SELECT count(*) INTO hidden_now FROM properties WHERE hidden;
  END IF;
  RETURN jsonb_build_object('dry_run', p_dry_run, 'hidden', hidden_now, 'changed', changed);
END $$;

--
-- Name: rekey_about_matters(jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.rekey_about_matters(p_about jsonb) RETURNS jsonb
    LANGUAGE sql STABLE
    SET search_path TO 'public'
    AS $_$
  SELECT coalesce(jsonb_object_agg(root, idx), '{}'::jsonb) FROM (
    SELECT root, coalesce(jsonb_agg(DISTINCT e ORDER BY e) FILTER (WHERE e IS NOT NULL), '[]'::jsonb) AS idx
      FROM (SELECT CASE WHEN j.k ~ '^[0-9]+$' THEN matter_root(j.k::bigint)::text ELSE j.k END AS root, e
              FROM jsonb_each(p_about) AS j(k, v)
              LEFT JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(j.v) = 'array' THEN j.v ELSE '[]'::jsonb END) AS e ON true) x
     GROUP BY root) y
$_$;

--
-- Name: repoint_matter_merges(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.repoint_matter_merges() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
BEGIN
  IF NEW.merged_into IS NOT NULL THEN
    UPDATE matters SET merged_into = NEW.merged_into WHERE merged_into = NEW.id;
  END IF;
  RETURN NULL;
END $$;

--
-- Name: rollback_transcript_identity_evidence(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.rollback_transcript_identity_evidence(p_evidence_id uuid) RETURNS jsonb
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public'
    AS $$
DECLARE
    v_receipt public.transcript_identity_evidence%ROWTYPE;
    v_current public.transcript_segments%ROWTYPE;
    v_after public.transcript_segments%ROWTYPE;
BEGIN
    -- Same lock order as apply (segment first) avoids cross-operation deadlocks.
    SELECT * INTO v_receipt FROM public.transcript_identity_evidence WHERE id=p_evidence_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'identity evidence unavailable'; END IF;
    SELECT * INTO v_current FROM public.transcript_segments WHERE id=v_receipt.segment_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'transcript segment unavailable'; END IF;
    SELECT * INTO v_receipt FROM public.transcript_identity_evidence WHERE id=p_evidence_id FOR UPDATE;
    IF v_receipt.status='reverted' AND to_jsonb(v_current)=v_receipt.reverted_row THEN
        RETURN jsonb_build_object('status','already_reverted','evidence_id',p_evidence_id);
    END IF;
    IF v_receipt.status IS DISTINCT FROM 'applied' OR to_jsonb(v_current) IS DISTINCT FROM v_receipt.after_row THEN
        RAISE EXCEPTION USING ERRCODE='40001', MESSAGE='transcript rollback compare-and-swap failed';
    END IF;
    UPDATE public.transcript_segments SET
        person_id=(v_receipt.before_row->>'person_id')::bigint,
        speaker_name=v_receipt.before_row->>'speaker_name',
        attribution_source=v_receipt.before_row->>'attribution_source'
        WHERE id=v_receipt.segment_id RETURNING * INTO v_after;
    UPDATE public.transcript_identity_evidence SET status='reverted',reverted_at=now(),reverted_row=to_jsonb(v_after)
        WHERE id=p_evidence_id;
    RETURN jsonb_build_object('status','reverted','evidence_id',p_evidence_id,'segment_id',v_receipt.segment_id);
END;
$$;

--
-- Name: search_daily_budget(integer, boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.search_daily_budget(p_limit integer, p_reserve boolean DEFAULT false) RETURNS TABLE(allowed boolean, remaining integer, resets_at timestamp with time zone)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  today date := (now() AT TIME ZONE 'America/Vancouver')::date;
  used integer := 0;
BEGIN
  IF p_limit IS NULL OR p_limit < 0 THEN
    RAISE EXCEPTION 'Invalid search daily limit';
  END IF;
  IF p_reserve AND p_limit > 0 THEN
    INSERT INTO public.search_daily_usage AS usage (day, requests)
      VALUES (today, 1)
      ON CONFLICT (day) DO UPDATE SET requests = usage.requests + 1
        WHERE usage.requests < p_limit
      RETURNING requests INTO used;
    IF NOT FOUND THEN
      RETURN QUERY SELECT false, 0, ((today + 1)::timestamp AT TIME ZONE 'America/Vancouver');
      RETURN;
    END IF;
    -- The last available reservation is allowed even though remaining becomes 0.
    RETURN QUERY SELECT true, greatest(0, p_limit - used), ((today + 1)::timestamp AT TIME ZONE 'America/Vancouver');
  ELSE
    SELECT requests INTO used FROM public.search_daily_usage WHERE day = today;
    RETURN QUERY SELECT coalesce(used, 0) < p_limit,
      greatest(0, p_limit - coalesce(used, 0)),
      ((today + 1)::timestamp AT TIME ZONE 'America/Vancouver');
  END IF;
END;
$$;

--
-- Name: set_email_alert_consent(boolean, boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_email_alert_consent(p_enabled boolean, p_complete_onboarding boolean DEFAULT false) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
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

--
-- Name: skip_own_mention(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.skip_own_mention() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  IF NEW.kind = 'mention' AND EXISTS (SELECT 1 FROM agenda_items WHERE id = NEW.agenda_item_id AND matter_id = NEW.matter_id) THEN
    RETURN NULL;
  END IF;
  RETURN NEW;
END $$;

--
-- Name: touch_public_content_version(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.touch_public_content_version() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  update public.public_content_version set changed_at = now()
  where id = 1 and changed_at < now() - interval '1 minute';
  return null;
end $$;

--
-- Name: trigger_agenda_item_slug(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.trigger_agenda_item_slug() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.slug IS NOT NULL THEN RETURN NEW; END IF;
  NEW.slug := NEW.meeting_id::text || '-' || COALESCE(NEW.item_order, NEW.id::text) || '-' || left(public.generate_slug(COALESCE(NEW.title, 'item'), 40), 40);
  RETURN NEW;
END;
$$;

--
-- Name: trigger_bylaw_slug(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.trigger_bylaw_slug() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  base text;
  candidate text;
  n int := 1;
BEGIN
  IF NEW.slug IS NOT NULL THEN RETURN NEW; END IF;
  base := public.bylaw_slug_base(NEW.bylaw_number, NEW.title);
  candidate := base;
  WHILE EXISTS (
    SELECT 1 FROM bylaws WHERE slug = candidate AND municipality_id IS NOT DISTINCT FROM NEW.municipality_id
  ) LOOP
    n := n + 1;
    candidate := base || '-' || n;
  END LOOP;
  NEW.slug := candidate;
  RETURN NEW;
END;
$$;

--
-- Name: trigger_election_slug(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.trigger_election_slug() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  base text;
  candidate text;
  n int := 1;
BEGIN
  IF NEW.slug IS NOT NULL THEN RETURN NEW; END IF;
  base := public.election_slug_base(NEW.name, NEW.election_date);
  candidate := base;
  WHILE EXISTS (SELECT 1 FROM elections WHERE slug = candidate) LOOP
    n := n + 1;
    candidate := base || '-' || n;
  END LOOP;
  NEW.slug := candidate;
  RETURN NEW;
END;
$$;

--
-- Name: trigger_matter_slug(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.trigger_matter_slug() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  base text;
  candidate text;
  n int := 1;
BEGIN
  IF NEW.slug IS NOT NULL THEN RETURN NEW; END IF;
  base := public.matter_slug_base(NEW.title, NEW.meta);
  candidate := base;
  WHILE EXISTS (
    SELECT 1 FROM matters WHERE slug = candidate AND municipality_id IS NOT DISTINCT FROM NEW.municipality_id
  ) LOOP
    n := n + 1;
    candidate := base || '-' || n;
  END LOOP;
  NEW.slug := candidate;
  RETURN NEW;
END;
$$;

--
-- Name: trigger_meeting_slug(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.trigger_meeting_slug() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  base_slug text;
  candidate text;
  suffix int := 1;
BEGIN
  IF NEW.slug IS NOT NULL THEN RETURN NEW; END IF;
  base_slug := NEW.meeting_date::text || '-' || public.generate_slug(NEW.type::text);
  candidate := base_slug;
  WHILE EXISTS (
    SELECT 1 FROM meetings WHERE slug = candidate AND municipality_id = NEW.municipality_id
  ) LOOP
    suffix := suffix + 1;
    candidate := base_slug || '-' || suffix;
  END LOOP;
  NEW.slug := candidate;
  RETURN NEW;
END;
$$;

--
-- Name: trigger_motion_slug(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.trigger_motion_slug() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.slug IS NOT NULL THEN RETURN NEW; END IF;
  NEW.slug := 'm-' || NEW.id::text;
  RETURN NEW;
END;
$$;

--
-- Name: trigger_person_slug(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.trigger_person_slug() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  base_slug text;
  candidate text;
  suffix int := 1;
BEGIN
  IF NEW.slug IS NOT NULL THEN RETURN NEW; END IF;
  base_slug := public.generate_slug(NEW.name);
  candidate := base_slug;
  WHILE EXISTS (SELECT 1 FROM people WHERE slug = candidate) LOOP
    suffix := suffix + 1;
    candidate := base_slug || '-' || suffix;
  END LOOP;
  NEW.slug := candidate;
  RETURN NEW;
END;
$$;

--
-- Name: unsubscribe_email_alerts(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.unsubscribe_email_alerts(p_token uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
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

--
-- Name: update_timestamp(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_timestamp() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

--
-- Name: update_user_location(uuid, double precision, double precision); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_user_location(target_user_id uuid, lng double precision, lat double precision) RETURNS void
    LANGUAGE sql
    SET search_path TO 'public'
    AS $$
  update user_profiles
  set location_lng = round(lng::numeric, 3)::double precision,
      location_lat = round(lat::numeric, 3)::double precision
  where id = target_user_id;
$$;

--
-- Name: agenda_item_topics; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agenda_item_topics (
    agenda_item_id bigint NOT NULL,
    topic_id bigint NOT NULL
);

--
-- Name: agenda_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agenda_items (
    id bigint NOT NULL,
    meeting_id bigint NOT NULL,
    matter_id bigint,
    parent_id bigint,
    item_order text,
    title text NOT NULL,
    description text,
    plain_english_summary text,
    category text,
    is_consent_agenda boolean DEFAULT false,
    matter_status_snapshot text,
    related_address text,
    neighborhood text,
    debate_summary text,
    is_controversial boolean DEFAULT false,
    discussion_start_time double precision,
    discussion_end_time double precision,
    financial_cost numeric,
    funding_source text,
    keywords text[],
    source_file text,
    embedding public.halfvec(384),
    text_search tsvector GENERATED ALWAYS AS (to_tsvector('english'::regconfig, ((((COALESCE(title, ''::text) || ' '::text) || COALESCE(plain_english_summary, ''::text)) || ' '::text) || COALESCE(debate_summary, ''::text)))) STORED,
    meta jsonb,
    created_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL,
    updated_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL,
    slug text NOT NULL,
    geo_location jsonb
);

--
-- Name: agenda_items_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.agenda_items ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.agenda_items_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

--
-- Name: ai_usage; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ai_usage (
    id bigint NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    source text NOT NULL,
    stage text NOT NULL,
    operation text,
    model text NOT NULL,
    input_tokens integer,
    output_tokens integer,
    latency_ms integer,
    attempts integer,
    ok boolean NOT NULL,
    error text,
    meeting_id bigint,
    job text,
    request_id text,
    pipeline_job_id bigint,
    CONSTRAINT ai_usage_source_check CHECK ((source = ANY (ARRAY['pipeline'::text, 'web'::text])))
);

--
-- Name: ai_usage_by_job; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.ai_usage_by_job WITH (security_invoker='true') AS
 SELECT pipeline_job_id,
    stage,
    model,
    operation,
    (count(*))::integer AS calls,
    (count(*) FILTER (WHERE (NOT ok)))::integer AS failed,
    COALESCE(sum(input_tokens), (0)::bigint) AS input_tokens,
    COALESCE(sum(output_tokens), (0)::bigint) AS output_tokens
   FROM public.ai_usage
  WHERE (pipeline_job_id IS NOT NULL)
  GROUP BY pipeline_job_id, stage, model, operation;

--
-- Name: ai_usage_daily; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ai_usage_daily (
    day date NOT NULL,
    source text DEFAULT ''::text NOT NULL,
    stage text DEFAULT ''::text NOT NULL,
    operation text DEFAULT ''::text NOT NULL,
    model text DEFAULT ''::text NOT NULL,
    calls bigint DEFAULT 0 NOT NULL,
    failures bigint DEFAULT 0 NOT NULL,
    input_tokens bigint DEFAULT 0 NOT NULL,
    output_tokens bigint DEFAULT 0 NOT NULL,
    latency_ms bigint DEFAULT 0 NOT NULL
);

--
-- Name: ai_usage_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.ai_usage_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: ai_usage_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.ai_usage_id_seq OWNED BY public.ai_usage.id;

--
-- Name: api_keys; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.api_keys (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    key_hash text NOT NULL,
    key_prefix character varying(8) NOT NULL,
    name text DEFAULT 'Default'::text NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    last_used_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: attendance; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.attendance (
    id bigint NOT NULL,
    meeting_id bigint NOT NULL,
    person_id bigint NOT NULL,
    attendance_mode text DEFAULT 'Unknown'::text,
    arrival_time timestamp with time zone,
    departure_time timestamp with time zone,
    notes text,
    created_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL,
    updated_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL,
    CONSTRAINT attendance_attendance_mode_check CHECK ((attendance_mode = ANY (ARRAY['In Person'::text, 'Remote'::text, 'Absent'::text, 'Regrets'::text, 'Unknown'::text])))
);

--
-- Name: attendance_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.attendance ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.attendance_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

--
-- Name: bylaw_chunks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.bylaw_chunks (
    id bigint NOT NULL,
    bylaw_id bigint NOT NULL,
    chunk_index integer NOT NULL,
    text_content text NOT NULL,
    embedding public.halfvec(384),
    created_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL,
    text_search tsvector GENERATED ALWAYS AS (to_tsvector('english'::regconfig, COALESCE(text_content, ''::text))) STORED
);

--
-- Name: bylaw_chunks_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.bylaw_chunks ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.bylaw_chunks_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

--
-- Name: bylaws; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.bylaws (
    id bigint NOT NULL,
    title text NOT NULL,
    bylaw_number text,
    year integer,
    category text,
    status text DEFAULT 'Active'::text,
    file_path text,
    source_url text,
    full_text text,
    plain_english_summary text,
    embedding public.halfvec(384),
    created_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL,
    updated_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL,
    slug text NOT NULL,
    municipality_id bigint DEFAULT 1,
    meta jsonb DEFAULT '{}'::jsonb NOT NULL
);

--
-- Name: bylaws_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.bylaws ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.bylaws_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

--
-- Name: calendar_sync_state; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.calendar_sync_state (
    municipality_id bigint NOT NULL,
    token uuid,
    lease_until timestamp with time zone,
    started_at timestamp with time zone,
    finished_at timestamp with time zone,
    last_trigger text DEFAULT 'manual'::text NOT NULL,
    status text NOT NULL,
    result jsonb DEFAULT '{}'::jsonb NOT NULL,
    last_error text
);

--
-- Name: candidacies; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.candidacies (
    id bigint NOT NULL,
    election_office_id bigint NOT NULL,
    person_id bigint NOT NULL,
    is_elected boolean DEFAULT false,
    is_acclaimed boolean DEFAULT false,
    votes_received integer,
    meta jsonb,
    created_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL,
    updated_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL
);

--
-- Name: candidacies_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.candidacies ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.candidacies_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

--
-- Name: channel_posts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.channel_posts (
    meeting_id bigint NOT NULL,
    channel text NOT NULL,
    message_id text,
    posted_at timestamp with time zone,
    payload_hash text,
    status text NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    last_error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT channel_posts_attempts_check CHECK ((attempts >= 0)),
    CONSTRAINT channel_posts_channel_check CHECK ((channel ~ '^[a-z][a-z0-9_-]{0,31}$'::text)),
    CONSTRAINT channel_posts_last_error_check CHECK (((last_error IS NULL) OR (length(last_error) <= 200))),
    CONSTRAINT channel_posts_message_id_check CHECK (((message_id IS NULL) OR (length(message_id) <= 64))),
    CONSTRAINT channel_posts_payload_hash_check CHECK (((payload_hash IS NULL) OR (payload_hash ~ '^[0-9a-f]{64}$'::text))),
    CONSTRAINT channel_posts_status_check CHECK ((status = ANY (ARRAY['posted'::text, 'failed'::text])))
);

--
-- Name: computed_cache; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.computed_cache (
    key text NOT NULL,
    payload jsonb NOT NULL,
    computed_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: contact_messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.contact_messages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text,
    email text NOT NULL,
    message text NOT NULL,
    client_ip text,
    created_at timestamp with time zone DEFAULT now(),
    handled_at timestamp with time zone,
    handled_by uuid,
    notified_at timestamp with time zone
);

--
-- Name: council_terms; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.council_terms (
    id bigint NOT NULL,
    municipality_id bigint NOT NULL,
    election_id bigint,
    name text NOT NULL,
    start_date date NOT NULL,
    end_date date,
    meta jsonb,
    created_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL,
    updated_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL,
    CONSTRAINT council_terms_dates_check CHECK (((end_date IS NULL) OR (end_date >= start_date)))
);

--
-- Name: TABLE council_terms; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.council_terms IS 'Municipal council tenures, beginning at the inaugural meeting, not election day.';

--
-- Name: COLUMN council_terms.end_date; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.council_terms.end_date IS 'Inclusive last day; NULL when the next inauguration is not yet confirmed.';

--
-- Name: council_terms_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.council_terms ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.council_terms_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

--
-- Name: councillor_highlights; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.councillor_highlights (
    id bigint NOT NULL,
    person_id bigint NOT NULL,
    highlights jsonb,
    overview text,
    narrative text,
    narrative_generated_at timestamp with time zone,
    generated_at timestamp with time zone,
    draft_overview text,
    draft_highlights jsonb,
    draft_generated_at timestamp with time zone,
    draft_evidence jsonb,
    published_stances jsonb,
    approved_at timestamp with time zone,
    approved_by text
);

--
-- Name: councillor_highlights_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.councillor_highlights ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.councillor_highlights_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

--
-- Name: councillor_stances; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.councillor_stances (
    id bigint NOT NULL,
    person_id bigint NOT NULL,
    topic text NOT NULL,
    "position" text NOT NULL,
    position_score double precision,
    summary text NOT NULL,
    evidence_quotes jsonb,
    evidence_motion_ids bigint[],
    evidence_vote_ids bigint[],
    statement_count integer NOT NULL,
    confidence text NOT NULL,
    generated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: councillor_stances_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.councillor_stances ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.councillor_stances_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

--
-- Name: data_reports; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.data_reports (
    id bigint NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    user_id uuid,
    path text NOT NULL,
    entry_key text,
    quote text,
    category text NOT NULL,
    note text,
    suggestion text,
    source_url text,
    notify_reporter boolean DEFAULT true NOT NULL,
    status text DEFAULT 'new'::text NOT NULL,
    assessment jsonb,
    assessed_at timestamp with time zone,
    duplicate_of bigint,
    resolution text,
    resolved_by uuid,
    resolved_at timestamp with time zone,
    notified_at timestamp with time zone,
    CONSTRAINT data_reports_category_check CHECK ((category = ANY (ARRAY['wrong_fact'::text, 'wrong_topic'::text, 'missing'::text, 'private'::text, 'other'::text]))),
    CONSTRAINT data_reports_entry_key_check CHECK ((length(entry_key) <= 200)),
    CONSTRAINT data_reports_note_check CHECK ((length(note) <= 2000)),
    CONSTRAINT data_reports_path_check CHECK (((path ~ '^/'::text) AND (length(path) <= 500))),
    CONSTRAINT data_reports_quote_check CHECK ((length(quote) <= 2000)),
    CONSTRAINT data_reports_resolution_check CHECK ((length(resolution) <= 2000)),
    CONSTRAINT data_reports_source_url_check CHECK (((source_url IS NULL) OR ((source_url ~ '^https?://'::text) AND (length(source_url) <= 1000)))),
    CONSTRAINT data_reports_status_check CHECK ((status = ANY (ARRAY['new'::text, 'assessed'::text, 'resolved'::text, 'declined'::text, 'duplicate'::text]))),
    CONSTRAINT data_reports_suggestion_check CHECK ((length(suggestion) <= 2000))
);

--
-- Name: data_reports_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.data_reports ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.data_reports_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

--
-- Name: document_images; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.document_images (
    id bigint NOT NULL,
    extracted_document_id bigint NOT NULL,
    r2_key text NOT NULL,
    page integer NOT NULL,
    description text,
    image_type text DEFAULT 'other'::text,
    width integer,
    height integer,
    format text,
    file_size integer,
    municipality_id bigint DEFAULT 1,
    created_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL,
    document_section_id bigint
);

--
-- Name: document_images_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.document_images ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.document_images_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

--
-- Name: document_sections; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.document_sections (
    id bigint NOT NULL,
    document_id bigint NOT NULL,
    agenda_item_id bigint,
    section_title text,
    section_text text NOT NULL,
    section_order integer NOT NULL,
    page_start integer,
    page_end integer,
    token_count integer,
    embedding public.halfvec(384),
    text_search tsvector GENERATED ALWAYS AS (to_tsvector('english'::regconfig, ((COALESCE(section_title, ''::text) || ' '::text) || COALESCE(section_text, ''::text)))) STORED,
    municipality_id bigint DEFAULT 1,
    created_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL,
    extracted_document_id bigint
);

--
-- Name: document_sections_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.document_sections ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.document_sections_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

--
-- Name: documents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.documents (
    id bigint NOT NULL,
    meeting_id bigint NOT NULL,
    title text NOT NULL,
    category text DEFAULT 'Other'::text NOT NULL,
    source_url text,
    file_path text NOT NULL,
    file_hash text,
    full_text text,
    page_count integer,
    embedding public.halfvec(384),
    municipality_id bigint DEFAULT 1,
    created_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL,
    updated_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL
);

--
-- Name: documents_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.documents ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.documents_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

--
-- Name: election_offices; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.election_offices (
    id bigint NOT NULL,
    election_id bigint NOT NULL,
    office text NOT NULL,
    seats_available integer,
    created_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL,
    updated_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL
);

--
-- Name: election_offices_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.election_offices ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.election_offices_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

--
-- Name: elections; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.elections (
    id bigint NOT NULL,
    name text NOT NULL,
    election_date date NOT NULL,
    classification text,
    term_length_years integer,
    notes text,
    source_id integer,
    meta jsonb,
    created_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL,
    updated_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL,
    results_status text DEFAULT 'pending'::text NOT NULL,
    source_url text,
    slug text NOT NULL,
    CONSTRAINT elections_results_status_check CHECK ((results_status = ANY (ARRAY['pending'::text, 'preliminary'::text, 'official'::text])))
);

--
-- Name: elections_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.elections ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.elections_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

--
-- Name: email_enqueue_receipts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.email_enqueue_receipts (
    meeting_id bigint NOT NULL,
    state text NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    first_attempt_at timestamp with time zone DEFAULT now() NOT NULL,
    next_attempt_at timestamp with time zone DEFAULT now() NOT NULL,
    last_error text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT email_enqueue_receipts_attempts_check CHECK ((attempts >= 0)),
    CONSTRAINT email_enqueue_receipts_last_error_check CHECK (((last_error IS NULL) OR (length(last_error) <= 200))),
    CONSTRAINT email_enqueue_receipts_state_check CHECK ((state = ANY (ARRAY['pending'::text, 'done'::text, 'skipped'::text, 'failed'::text, 'expired'::text])))
);

--
-- Name: email_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.email_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    message_id uuid NOT NULL,
    event_type text NOT NULL,
    attempt_number integer,
    provider_event_id text,
    provider_message_id text,
    error_text text,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT email_events_attempt_number_check CHECK ((attempt_number > 0)),
    CONSTRAINT email_events_error_text_check CHECK ((length(error_text) <= 1000)),
    CONSTRAINT email_events_event_type_check CHECK ((event_type = ANY (ARRAY['attempt_started'::text, 'accepted'::text, 'delivered'::text, 'failed'::text, 'bounced'::text, 'complained'::text, 'suppressed'::text])))
);

--
-- Name: TABLE email_events; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.email_events IS 'V1 append-only attempt/provider timeline. Delivery requires verified webhook integration.';

--
-- Name: email_suppressions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.email_suppressions (
    recipient text NOT NULL,
    user_id uuid,
    reason text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT email_suppressions_reason_check CHECK ((reason = ANY (ARRAY['unsubscribe'::text, 'bounced'::text, 'complained'::text, 'provider'::text]))),
    CONSTRAINT email_suppressions_recipient_check CHECK ((recipient = lower(btrim(recipient))))
);

--
-- Name: extracted_documents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.extracted_documents (
    id bigint NOT NULL,
    document_id bigint NOT NULL,
    agenda_item_id bigint,
    title text NOT NULL,
    document_type text DEFAULT 'other'::text NOT NULL,
    page_start integer,
    page_end integer,
    summary text,
    key_facts jsonb,
    municipality_id bigint DEFAULT 1,
    created_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL
);

--
-- Name: extracted_documents_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.extracted_documents ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.extracted_documents_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

--
-- Name: hidden_pages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.hidden_pages (
    record_table text NOT NULL,
    record_id bigint NOT NULL,
    path text NOT NULL,
    hidden_by uuid,
    hidden_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT hidden_pages_record_table_check CHECK ((record_table = ANY (ARRAY['meetings'::text, 'properties'::text, 'people'::text, 'elections'::text])))
);

--
-- Name: key_statements; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.key_statements (
    id bigint NOT NULL,
    meeting_id bigint NOT NULL,
    agenda_item_id bigint,
    speaker_name text,
    person_id bigint,
    statement_type text NOT NULL,
    statement_text text NOT NULL,
    context text,
    source_segment_ids bigint[],
    start_time double precision,
    municipality_id bigint DEFAULT 1,
    embedding public.halfvec(384),
    created_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL,
    updated_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL,
    text_search tsvector GENERATED ALWAYS AS (to_tsvector('english'::regconfig, ((((COALESCE(statement_text, ''::text) || ' '::text) || COALESCE(context, ''::text)) || ' '::text) || COALESCE(speaker_name, ''::text)))) STORED,
    evidence_kind text,
    CONSTRAINT key_statements_evidence_kind_check CHECK ((evidence_kind = ANY (ARRAY['transcript'::text, 'recorded_vote'::text, 'institutional_direction'::text])))
);

--
-- Name: key_statements_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.key_statements ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.key_statements_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

--
-- Name: key_votes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.key_votes (
    id bigint NOT NULL,
    person_id bigint NOT NULL,
    motion_id bigint NOT NULL,
    vote text NOT NULL,
    detection_type text[] NOT NULL,
    composite_score double precision NOT NULL,
    context_summary text,
    ally_breaks jsonb,
    vote_split text,
    generated_at timestamp with time zone DEFAULT now(),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: key_votes_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.key_votes ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.key_votes_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

--
-- Name: matter_evidence; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.matter_evidence (
    id bigint NOT NULL,
    matter_id bigint NOT NULL,
    agenda_item_id bigint,
    document_section_id bigint,
    evidence_type text DEFAULT 'related'::text NOT NULL,
    confidence numeric DEFAULT 0.75 NOT NULL,
    reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    hidden boolean DEFAULT false NOT NULL,
    review text,
    reviewed_by uuid,
    reviewed_at timestamp with time zone,
    CONSTRAINT matter_evidence_check CHECK (((agenda_item_id IS NOT NULL) OR (document_section_id IS NOT NULL))),
    CONSTRAINT matter_evidence_review_check CHECK ((review = 'removed'::text))
);

--
-- Name: matter_evidence_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.matter_evidence ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.matter_evidence_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

--
-- Name: matter_links; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.matter_links (
    id bigint NOT NULL,
    matter_id bigint NOT NULL,
    kind text NOT NULL,
    related_matter_id bigint,
    agenda_item_id bigint,
    confidence real,
    source text DEFAULT 'resolver'::text NOT NULL,
    hidden boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    quote text,
    suggested_at timestamp with time zone,
    review text,
    reviewed_by uuid,
    reviewed_at timestamp with time zone,
    suggest_reason text,
    found_in text,
    CONSTRAINT matter_links_check CHECK ((((kind = 'related_matter'::text) AND (related_matter_id IS NOT NULL) AND (agenda_item_id IS NULL) AND (related_matter_id <> matter_id)) OR ((kind = 'mention'::text) AND (agenda_item_id IS NOT NULL) AND (related_matter_id IS NULL)))),
    CONSTRAINT matter_links_found_in_check CHECK ((found_in = ANY (ARRAY['item'::text, 'document'::text, 'spoken'::text, 'report'::text, 'topic'::text, 'similar'::text]))),
    CONSTRAINT matter_links_kind_check CHECK ((kind = ANY (ARRAY['related_matter'::text, 'mention'::text]))),
    CONSTRAINT matter_links_review_check CHECK ((review = ANY (ARRAY['removed'::text, 'accepted'::text, 'rejected'::text])))
);

--
-- Name: matter_links_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.matter_links_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: matter_links_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.matter_links_id_seq OWNED BY public.matter_links.id;

--
-- Name: matter_merge_proposals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.matter_merge_proposals (
    id bigint NOT NULL,
    matter_ids bigint[] NOT NULL,
    decisions jsonb DEFAULT '[]'::jsonb NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    source text DEFAULT 'resolver'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    decided_at timestamp with time zone,
    decided_by text,
    CONSTRAINT matter_merge_proposals_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text])))
);

--
-- Name: matter_merge_proposals_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.matter_merge_proposals_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: matter_merge_proposals_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.matter_merge_proposals_id_seq OWNED BY public.matter_merge_proposals.id;

--
-- Name: matter_merges; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.matter_merges (
    id bigint NOT NULL,
    canonical_id bigint NOT NULL,
    alias_ids bigint[] NOT NULL,
    reason text,
    merged_by text,
    merged_at timestamp with time zone DEFAULT now() NOT NULL,
    moved jsonb DEFAULT '{}'::jsonb NOT NULL,
    removed jsonb DEFAULT '{}'::jsonb NOT NULL,
    notes jsonb DEFAULT '[]'::jsonb NOT NULL
);

--
-- Name: matter_merges_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.matter_merges ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.matter_merges_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

--
-- Name: matter_report_mentions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.matter_report_mentions (
    id bigint NOT NULL,
    matter_id bigint NOT NULL,
    report_id bigint NOT NULL,
    page integer NOT NULL,
    quote text NOT NULL,
    confidence real,
    source text DEFAULT 'name'::text NOT NULL,
    hidden boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    suggested_at timestamp with time zone,
    review text,
    reviewed_by uuid,
    reviewed_at timestamp with time zone,
    suggest_reason text,
    CONSTRAINT matter_report_mentions_review_check CHECK ((review = ANY (ARRAY['removed'::text, 'accepted'::text, 'rejected'::text])))
);

--
-- Name: matter_report_mentions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.matter_report_mentions_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: matter_report_mentions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.matter_report_mentions_id_seq OWNED BY public.matter_report_mentions.id;

--
-- Name: matters; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.matters (
    id bigint NOT NULL,
    title text NOT NULL,
    identifier text,
    description text,
    plain_english_summary text,
    category text,
    status text DEFAULT 'Active'::text,
    first_seen date,
    last_seen date,
    embedding public.halfvec(384),
    text_search tsvector GENERATED ALWAYS AS (to_tsvector('english'::regconfig, ((COALESCE(title, ''::text) || ' '::text) || COALESCE(plain_english_summary, description, ''::text)))) STORED,
    meta jsonb,
    created_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL,
    updated_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL,
    slug text NOT NULL,
    municipality_id bigint DEFAULT 1,
    bylaw_id bigint,
    geo_location jsonb,
    merged_into bigint,
    CONSTRAINT matters_merged_into_not_self CHECK (((merged_into IS NULL) OR (merged_into <> id)))
);

--
-- Name: matters_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.matters ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.matters_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

--
-- Name: meeting_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.meeting_events (
    id bigint NOT NULL,
    meeting_id bigint NOT NULL,
    person_id bigint NOT NULL,
    event_type text NOT NULL,
    time_offset_seconds integer,
    created_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL,
    updated_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL
);

--
-- Name: meeting_events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.meeting_events ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.meeting_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

--
-- Name: meeting_slug_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.meeting_slug_history (
    id bigint NOT NULL,
    meeting_id bigint NOT NULL,
    municipality_id bigint NOT NULL,
    old_slug text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: meeting_slug_history_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.meeting_slug_history_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: meeting_slug_history_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.meeting_slug_history_id_seq OWNED BY public.meeting_slug_history.id;

--
-- Name: meeting_speaker_aliases; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.meeting_speaker_aliases (
    id bigint NOT NULL,
    meeting_id bigint NOT NULL,
    speaker_label text NOT NULL,
    person_id bigint NOT NULL,
    created_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL,
    updated_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL
);

--
-- Name: meeting_speaker_aliases_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.meeting_speaker_aliases ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.meeting_speaker_aliases_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

--
-- Name: meetings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.meetings (
    id bigint NOT NULL,
    organization_id bigint,
    title text NOT NULL,
    meeting_date date NOT NULL,
    type public.meeting_type,
    status text DEFAULT 'Planned'::text,
    has_agenda boolean DEFAULT false,
    has_minutes boolean DEFAULT false,
    has_transcript boolean DEFAULT false,
    video_url text,
    minutes_url text,
    agenda_url text,
    video_duration_seconds integer,
    chair_person_id bigint,
    archive_path text,
    summary text,
    embedding public.halfvec(384),
    meta jsonb,
    created_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL,
    updated_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL,
    slug text NOT NULL,
    municipality_id bigint DEFAULT 1,
    calendar_source_id bigint
);

--
-- Name: meetings_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.meetings ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.meetings_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

--
-- Name: memberships; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.memberships (
    id bigint NOT NULL,
    person_id bigint NOT NULL,
    organization_id bigint NOT NULL,
    role text,
    start_date date,
    end_date date,
    meta jsonb,
    created_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL,
    updated_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL,
    council_term_id bigint
);

--
-- Name: memberships_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.memberships ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.memberships_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

--
-- Name: motions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.motions (
    id bigint NOT NULL,
    meeting_id bigint NOT NULL,
    agenda_item_id bigint NOT NULL,
    mover text,
    seconder text,
    mover_id bigint,
    seconder_id bigint,
    text_content text NOT NULL,
    plain_english_summary text,
    disposition text,
    result text,
    yes_votes integer DEFAULT 0,
    no_votes integer DEFAULT 0,
    abstain_votes integer DEFAULT 0,
    absent_votes integer DEFAULT 0,
    time_offset_seconds double precision,
    financial_cost numeric,
    funding_source text,
    embedding public.halfvec(384),
    text_search tsvector GENERATED ALWAYS AS (to_tsvector('english'::regconfig, ((COALESCE(text_content, ''::text) || ' '::text) || COALESCE(plain_english_summary, ''::text)))) STORED,
    meta jsonb,
    created_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL,
    updated_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL,
    slug text NOT NULL
);

--
-- Name: motions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.motions ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.motions_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

--
-- Name: municipalities; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.municipalities (
    id bigint NOT NULL,
    slug text NOT NULL,
    name text NOT NULL,
    short_name text NOT NULL,
    province text DEFAULT 'BC'::text,
    classification text DEFAULT 'City'::text,
    source_config jsonb DEFAULT '{}'::jsonb NOT NULL,
    map_center_lat double precision,
    map_center_lng double precision,
    website_url text,
    rss_url text,
    contact_email text,
    ocd_id text,
    meta jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: municipalities_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.municipalities ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.municipalities_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

--
-- Name: ocd_divisions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ocd_divisions (
    id bigint NOT NULL,
    division_id text NOT NULL,
    name text NOT NULL,
    country text DEFAULT 'ca'::text NOT NULL,
    csd_code text,
    created_at timestamp with time zone DEFAULT now()
);

--
-- Name: ocd_divisions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.ocd_divisions ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.ocd_divisions_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

--
-- Name: organizations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.organizations (
    id bigint NOT NULL,
    name text NOT NULL,
    classification public.org_classification DEFAULT 'Committee'::public.org_classification,
    meta jsonb,
    created_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL,
    updated_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL,
    municipality_id bigint DEFAULT 1
);

--
-- Name: organizations_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.organizations ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.organizations_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

--
-- Name: page_reviews; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.page_reviews (
    path text NOT NULL,
    kind text NOT NULL,
    title text,
    status text,
    note text,
    reviewed_by uuid,
    reviewed_at timestamp with time zone,
    ai_flags jsonb,
    ai_page_issue text,
    ai_model text,
    ai_checked_at timestamp with time zone,
    ai_summary text,
    ai_entries integer,
    agent_note text,
    agent_at timestamp with time zone,
    ai_rated_history jsonb,
    ai_guidance_version integer,
    internal_note text,
    internal_note_by uuid,
    internal_note_at timestamp with time zone,
    check_requested_at timestamp with time zone,
    CONSTRAINT page_reviews_path_check CHECK ((path ~~ '/%'::text)),
    CONSTRAINT page_reviews_status_check CHECK ((status = ANY (ARRAY['reviewed'::text, 'needs_work'::text, 'fixing'::text, 'fixed'::text])))
);

--
-- Name: people; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.people (
    id bigint NOT NULL,
    name text NOT NULL,
    is_councillor boolean DEFAULT false,
    email text,
    image_url text,
    bio text,
    voice_fingerprint_id text,
    meta jsonb,
    created_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL,
    updated_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL,
    slug text NOT NULL
);

--
-- Name: people_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.people ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.people_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

--
-- Name: pipeline_jobs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.pipeline_jobs ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.pipeline_jobs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

--
-- Name: pipeline_run_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pipeline_run_events (
    id bigint NOT NULL,
    job_id bigint NOT NULL,
    level text DEFAULT 'info'::text NOT NULL,
    message text NOT NULL,
    data jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL,
    CONSTRAINT pipeline_run_events_level_check CHECK ((level = ANY (ARRAY['debug'::text, 'info'::text, 'warning'::text, 'error'::text])))
);

--
-- Name: pipeline_run_events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.pipeline_run_events ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.pipeline_run_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

--
-- Name: properties; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.properties (
    id bigint NOT NULL,
    municipality_id bigint DEFAULT 1 NOT NULL,
    slug text NOT NULL,
    address text NOT NULL,
    civic_number text NOT NULL,
    street text NOT NULL,
    geo jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    geocode_attempted_at timestamp with time zone,
    meta jsonb DEFAULT '{}'::jsonb NOT NULL,
    hidden boolean DEFAULT true NOT NULL
);

--
-- Name: properties_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.properties_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: properties_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.properties_id_seq OWNED BY public.properties.id;

--
-- Name: property_links; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.property_links (
    id bigint NOT NULL,
    property_id bigint NOT NULL,
    agenda_item_id bigint,
    matter_id bigint,
    source text NOT NULL,
    hidden boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT property_links_check CHECK (((agenda_item_id IS NOT NULL) OR (matter_id IS NOT NULL))),
    CONSTRAINT property_links_source_check CHECK ((source = ANY (ARRAY['item_address'::text, 'item_title'::text, 'matter_title'::text, 'admin'::text])))
);

--
-- Name: property_links_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.property_links_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: property_links_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.property_links_id_seq OWNED BY public.property_links.id;

--
-- Name: public_content_version; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.public_content_version (
    id smallint DEFAULT 1 NOT NULL,
    changed_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT public_content_version_id_check CHECK ((id = 1))
);

--
-- Name: public_report_pages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.public_report_pages (
    report_id bigint NOT NULL,
    page integer NOT NULL,
    content text NOT NULL,
    text_search tsvector GENERATED ALWAYS AS (to_tsvector('english'::regconfig, content)) STORED,
    CONSTRAINT public_report_pages_page_check CHECK ((page >= 1))
);

--
-- Name: public_reports; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.public_reports (
    id bigint NOT NULL,
    municipality_id bigint NOT NULL,
    kind text NOT NULL,
    year integer NOT NULL,
    title text NOT NULL,
    source_url text,
    file_hash text,
    page_count integer,
    meta jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT public_reports_kind_check CHECK ((kind = 'annual_report'::text))
);

--
-- Name: public_reports_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.public_reports_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: public_reports_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.public_reports_id_seq OWNED BY public.public_reports.id;

--
-- Name: public_speaker_names; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.public_speaker_names (
    id bigint NOT NULL,
    municipality_id bigint DEFAULT 1 NOT NULL,
    meeting_id bigint NOT NULL,
    agenda_item_id bigint NOT NULL,
    name_key text NOT NULL,
    transcribed_name text NOT NULL,
    display_name text,
    status text NOT NULL,
    basis text NOT NULL,
    conflict jsonb DEFAULT '{}'::jsonb NOT NULL,
    source_segment_ids bigint[] DEFAULT '{}'::bigint[] NOT NULL,
    start_time double precision,
    decided_by text,
    decided_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT public_speaker_names_basis_check CHECK ((basis = ANY (ARRAY['registry'::text, 'minutes'::text, 'known'::text, 'introduction'::text, 'admin'::text]))),
    CONSTRAINT public_speaker_names_status_check CHECK ((status = ANY (ARRAY['published'::text, 'review'::text, 'anonymous'::text])))
);

--
-- Name: public_speaker_names_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.public_speaker_names_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: public_speaker_names_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.public_speaker_names_id_seq OWNED BY public.public_speaker_names.id;

--
-- Name: rag_feedback; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.rag_feedback (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    trace_id uuid NOT NULL,
    rating smallint NOT NULL,
    comment text,
    user_id uuid,
    client_ip text,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT rag_feedback_rating_check CHECK ((rating = ANY (ARRAY['-1'::integer, 1])))
);

--
-- Name: rag_traces; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.rag_traces (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    query text NOT NULL,
    answer text,
    model text DEFAULT 'gemini-2.0-flash'::text,
    latency_ms integer,
    tool_calls jsonb DEFAULT '[]'::jsonb,
    source_count integer DEFAULT 0,
    sources jsonb DEFAULT '[]'::jsonb,
    client_ip text,
    user_id uuid,
    posthog_trace_id text,
    created_at timestamp with time zone DEFAULT now()
);

--
-- Name: review_examples; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.review_examples (
    id bigint NOT NULL,
    path text NOT NULL,
    page_kind text NOT NULL,
    entry_key text,
    problem text NOT NULL,
    entry_text text NOT NULL,
    reason text NOT NULL,
    verdict text NOT NULL,
    note text,
    model text,
    guidance_version integer,
    rated_by uuid,
    embedding public.halfvec(384),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT review_examples_verdict_check CHECK ((verdict = ANY (ARRAY['agree'::text, 'disagree'::text])))
);

--
-- Name: review_examples_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.review_examples_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: review_examples_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.review_examples_id_seq OWNED BY public.review_examples.id;

--
-- Name: review_guidance; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.review_guidance (
    id bigint NOT NULL,
    problem text NOT NULL,
    page_kind text,
    text text NOT NULL,
    status text NOT NULL,
    based_on integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    decided_by uuid,
    decided_at timestamp with time zone,
    CONSTRAINT review_guidance_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'approved'::text, 'retired'::text])))
);

--
-- Name: review_guidance_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.review_guidance_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: review_guidance_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.review_guidance_id_seq OWNED BY public.review_guidance.id;

--
-- Name: search_daily_usage; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.search_daily_usage (
    day date NOT NULL,
    requests integer DEFAULT 0 NOT NULL,
    CONSTRAINT search_daily_usage_requests_check CHECK ((requests >= 0))
);

--
-- Name: search_results_cache; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.search_results_cache (
    id text DEFAULT substr((gen_random_uuid())::text, 1, 8) NOT NULL,
    query text NOT NULL,
    answer text NOT NULL,
    sources jsonb DEFAULT '[]'::jsonb NOT NULL,
    suggested_followups text[] DEFAULT '{}'::text[],
    source_count integer DEFAULT 0,
    created_at timestamp with time zone DEFAULT now(),
    expires_at timestamp with time zone DEFAULT (now() + '30 days'::interval),
    normalized_query text,
    request_id text
);

--
-- Name: server_metrics; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.server_metrics (
    sampled_at timestamp with time zone DEFAULT now() NOT NULL,
    mem_total_bytes bigint,
    mem_available_bytes bigint,
    swap_total_bytes bigint,
    swap_free_bytes bigint,
    swap_in_pages bigint,
    swap_out_pages bigint,
    root_read_bytes bigint,
    data_read_bytes bigint,
    data_written_bytes bigint,
    io_stalled_seconds double precision,
    memory_stalled_seconds double precision,
    cpu_busy_seconds double precision,
    cpu_total_seconds double precision,
    database_bytes bigint,
    connections integer
);

--
-- Name: source_meetings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.source_meetings (
    id bigint NOT NULL,
    municipality_id bigint NOT NULL,
    source_type text NOT NULL,
    source_id text NOT NULL,
    meeting_date date NOT NULL,
    title text NOT NULL,
    meeting_type text,
    source_url text,
    video_url text,
    archive_path text,
    raw jsonb DEFAULT '{}'::jsonb NOT NULL,
    status text DEFAULT 'discovered'::text NOT NULL,
    last_error text,
    discovered_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL,
    last_seen_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL,
    ingested_meeting_id bigint,
    created_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL,
    updated_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL
);

--
-- Name: source_meetings_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.source_meetings ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.source_meetings_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

--
-- Name: staff_actions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.staff_actions (
    id bigint NOT NULL,
    user_id uuid,
    role text NOT NULL,
    path text NOT NULL,
    action text,
    detail jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: staff_actions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.staff_actions_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: staff_actions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.staff_actions_id_seq OWNED BY public.staff_actions.id;

--
-- Name: subscriptions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.subscriptions (
    id bigint NOT NULL,
    user_id uuid NOT NULL,
    type public.subscription_type NOT NULL,
    matter_id bigint,
    topic_id bigint,
    person_id bigint,
    neighborhood text,
    proximity_radius_m integer DEFAULT 1000 NOT NULL,
    keyword text,
    keyword_embedding public.halfvec(384),
    is_active boolean DEFAULT true NOT NULL,
    meta jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: subscriptions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.subscriptions ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.subscriptions_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

--
-- Name: topics; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.topics (
    id bigint NOT NULL,
    name text NOT NULL,
    description text,
    created_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL,
    updated_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL
);

--
-- Name: topics_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.topics ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.topics_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

--
-- Name: transcript_identity_evidence; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.transcript_identity_evidence (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    segment_id bigint NOT NULL,
    meeting_id bigint NOT NULL,
    person_id bigint NOT NULL,
    validator_version text NOT NULL,
    validator_sha256 text NOT NULL,
    identity_evidence_sha256 text NOT NULL,
    input_sha256 text NOT NULL,
    source_run jsonb NOT NULL,
    evidence jsonb NOT NULL,
    before_row jsonb NOT NULL,
    after_row jsonb NOT NULL,
    status text DEFAULT 'applied'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    reverted_at timestamp with time zone,
    reverted_row jsonb,
    CONSTRAINT transcript_identity_evidence_after_row_check CHECK ((jsonb_typeof(after_row) = 'object'::text)),
    CONSTRAINT transcript_identity_evidence_before_row_check CHECK ((jsonb_typeof(before_row) = 'object'::text)),
    CONSTRAINT transcript_identity_evidence_check CHECK ((((status = 'applied'::text) AND (reverted_at IS NULL) AND (reverted_row IS NULL)) OR ((status = 'reverted'::text) AND (reverted_at IS NOT NULL) AND (reverted_row IS NOT NULL) AND (jsonb_typeof(reverted_row) = 'object'::text)))),
    CONSTRAINT transcript_identity_evidence_evidence_check CHECK ((jsonb_typeof(evidence) = 'object'::text)),
    CONSTRAINT transcript_identity_evidence_identity_evidence_sha256_check CHECK ((identity_evidence_sha256 ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT transcript_identity_evidence_input_sha256_check CHECK ((input_sha256 ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT transcript_identity_evidence_source_run_check CHECK (((jsonb_typeof(source_run) = 'object'::text) AND COALESCE((TRIM(BOTH FROM (source_run ->> 'recording_id'::text)) <> ''::text), false) AND COALESCE(((source_run ->> 'meeting_id'::text) ~ '^[0-9]+$'::text), false) AND COALESCE(((source_run ->> 'recording_sha256'::text) ~ '^[0-9a-f]{64}$'::text), false) AND COALESCE(((source_run ->> 'transcript_sha256'::text) ~ '^[0-9a-f]{64}$'::text), false) AND COALESCE(((source_run ->> 'diarization_run_sha256'::text) ~ '^[0-9a-f]{64}$'::text), false))),
    CONSTRAINT transcript_identity_evidence_status_check CHECK ((status = ANY (ARRAY['applied'::text, 'reverted'::text]))),
    CONSTRAINT transcript_identity_evidence_validator_sha256_check CHECK ((validator_sha256 ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT transcript_identity_evidence_validator_version_check CHECK ((length(validator_version) > 0))
);

--
-- Name: TABLE transcript_identity_evidence; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.transcript_identity_evidence IS 'Private source/run-bound machine identity proofs and full before/after rollback. No public read policy.';

--
-- Name: transcript_segments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.transcript_segments (
    id bigint NOT NULL,
    meeting_id bigint NOT NULL,
    person_id bigint,
    agenda_item_id bigint,
    motion_id bigint,
    speaker_name text,
    speaker_role text,
    start_time double precision NOT NULL,
    end_time double precision NOT NULL,
    text_content text NOT NULL,
    attribution_source text DEFAULT 'AI_DIARIZATION'::text,
    is_verified boolean DEFAULT false,
    is_procedural boolean DEFAULT false,
    sentiment_score double precision,
    text_search tsvector GENERATED ALWAYS AS (to_tsvector('english'::regconfig, COALESCE(text_content, ''::text))) STORED,
    created_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL,
    updated_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL
);

--
-- Name: transcript_segments_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.transcript_segments ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.transcript_segments_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

--
-- Name: user_profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_profiles (
    id uuid NOT NULL,
    display_name text,
    neighborhood text,
    notification_email text,
    email_verified boolean DEFAULT false NOT NULL,
    digest_frequency public.digest_frequency DEFAULT 'each_meeting'::public.digest_frequency NOT NULL,
    digest_enabled boolean DEFAULT false NOT NULL,
    onboarding_completed boolean DEFAULT false NOT NULL,
    location_lat double precision,
    location_lng double precision,
    meta jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    email_alerts_enabled boolean DEFAULT false NOT NULL,
    email_alerts_consent_at timestamp with time zone,
    email_alerts_consent_version text,
    location_label text
);

--
-- Name: COLUMN user_profiles.location_lat; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.user_profiles.location_lat IS 'Rounded to 3 decimals (about a block). The typed address is never stored.';

--
-- Name: COLUMN user_profiles.location_lng; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.user_profiles.location_lng IS 'Rounded to 3 decimals (about a block). The typed address is never stored.';

--
-- Name: COLUMN user_profiles.location_label; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.user_profiles.location_label IS 'Street name only, no house number.';

--
-- Name: user_roles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_roles (
    user_id uuid NOT NULL,
    role text NOT NULL,
    granted_by uuid,
    granted_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT user_roles_role_check CHECK ((role = ANY (ARRAY['admin'::text, 'moderator'::text])))
);

--
-- Name: voice_exemplars; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.voice_exemplars (
    id bigint NOT NULL,
    person_id bigint NOT NULL,
    meeting_id bigint NOT NULL,
    speaker_label text NOT NULL,
    embedding jsonb NOT NULL,
    source text NOT NULL,
    confidence double precision DEFAULT 0.5 NOT NULL,
    speech_seconds double precision,
    evidence jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT voice_exemplars_source_check CHECK ((source = ANY (ARRAY['manual'::text, 'evidence'::text, 'voice'::text])))
);

--
-- Name: voice_exemplars_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.voice_exemplars ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.voice_exemplars_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

--
-- Name: voice_fingerprints; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.voice_fingerprints (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    person_id bigint NOT NULL,
    embedding jsonb NOT NULL,
    source_meeting_id bigint,
    confidence double precision DEFAULT 1.0,
    created_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL,
    updated_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL,
    source text DEFAULT 'manual'::text NOT NULL,
    exemplar_count integer,
    meeting_count integer
);

--
-- Name: votes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.votes (
    id bigint NOT NULL,
    motion_id bigint NOT NULL,
    person_id bigint NOT NULL,
    vote text NOT NULL,
    recusal_reason text,
    created_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL,
    updated_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL
);

--
-- Name: votes_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.votes ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.votes_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

--
-- Name: ai_usage id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_usage ALTER COLUMN id SET DEFAULT nextval('public.ai_usage_id_seq'::regclass);

--
-- Name: matter_links id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.matter_links ALTER COLUMN id SET DEFAULT nextval('public.matter_links_id_seq'::regclass);

--
-- Name: matter_merge_proposals id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.matter_merge_proposals ALTER COLUMN id SET DEFAULT nextval('public.matter_merge_proposals_id_seq'::regclass);

--
-- Name: matter_report_mentions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.matter_report_mentions ALTER COLUMN id SET DEFAULT nextval('public.matter_report_mentions_id_seq'::regclass);

--
-- Name: meeting_slug_history id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meeting_slug_history ALTER COLUMN id SET DEFAULT nextval('public.meeting_slug_history_id_seq'::regclass);

--
-- Name: properties id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.properties ALTER COLUMN id SET DEFAULT nextval('public.properties_id_seq'::regclass);

--
-- Name: property_links id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.property_links ALTER COLUMN id SET DEFAULT nextval('public.property_links_id_seq'::regclass);

--
-- Name: public_reports id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.public_reports ALTER COLUMN id SET DEFAULT nextval('public.public_reports_id_seq'::regclass);

--
-- Name: public_speaker_names id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.public_speaker_names ALTER COLUMN id SET DEFAULT nextval('public.public_speaker_names_id_seq'::regclass);

--
-- Name: review_examples id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.review_examples ALTER COLUMN id SET DEFAULT nextval('public.review_examples_id_seq'::regclass);

--
-- Name: review_guidance id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.review_guidance ALTER COLUMN id SET DEFAULT nextval('public.review_guidance_id_seq'::regclass);

--
-- Name: staff_actions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_actions ALTER COLUMN id SET DEFAULT nextval('public.staff_actions_id_seq'::regclass);

--
-- Name: agenda_item_topics agenda_item_topics_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agenda_item_topics
    ADD CONSTRAINT agenda_item_topics_pkey PRIMARY KEY (agenda_item_id, topic_id);

--
-- Name: agenda_items agenda_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agenda_items
    ADD CONSTRAINT agenda_items_pkey PRIMARY KEY (id);

--
-- Name: ai_usage_daily ai_usage_daily_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_usage_daily
    ADD CONSTRAINT ai_usage_daily_pkey PRIMARY KEY (day, source, stage, operation, model);

--
-- Name: ai_usage ai_usage_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_usage
    ADD CONSTRAINT ai_usage_pkey PRIMARY KEY (id);

--
-- Name: api_keys api_keys_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_keys
    ADD CONSTRAINT api_keys_pkey PRIMARY KEY (id);

--
-- Name: attendance attendance_meeting_id_person_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attendance
    ADD CONSTRAINT attendance_meeting_id_person_id_key UNIQUE (meeting_id, person_id);

--
-- Name: attendance attendance_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attendance
    ADD CONSTRAINT attendance_pkey PRIMARY KEY (id);

--
-- Name: bylaw_chunks bylaw_chunks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bylaw_chunks
    ADD CONSTRAINT bylaw_chunks_pkey PRIMARY KEY (id);

--
-- Name: bylaws bylaws_file_path_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bylaws
    ADD CONSTRAINT bylaws_file_path_key UNIQUE (file_path);

--
-- Name: bylaws bylaws_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bylaws
    ADD CONSTRAINT bylaws_pkey PRIMARY KEY (id);

--
-- Name: calendar_sync_state calendar_sync_state_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.calendar_sync_state
    ADD CONSTRAINT calendar_sync_state_pkey PRIMARY KEY (municipality_id);

--
-- Name: candidacies candidacies_election_office_id_person_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.candidacies
    ADD CONSTRAINT candidacies_election_office_id_person_id_key UNIQUE (election_office_id, person_id);

--
-- Name: candidacies candidacies_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.candidacies
    ADD CONSTRAINT candidacies_pkey PRIMARY KEY (id);

--
-- Name: channel_posts channel_posts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channel_posts
    ADD CONSTRAINT channel_posts_pkey PRIMARY KEY (meeting_id, channel);

--
-- Name: computed_cache computed_cache_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.computed_cache
    ADD CONSTRAINT computed_cache_pkey PRIMARY KEY (key);

--
-- Name: contact_messages contact_messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contact_messages
    ADD CONSTRAINT contact_messages_pkey PRIMARY KEY (id);

--
-- Name: council_terms council_terms_municipality_id_start_date_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.council_terms
    ADD CONSTRAINT council_terms_municipality_id_start_date_key UNIQUE (municipality_id, start_date);

--
-- Name: council_terms council_terms_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.council_terms
    ADD CONSTRAINT council_terms_pkey PRIMARY KEY (id);

--
-- Name: councillor_highlights councillor_highlights_person_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.councillor_highlights
    ADD CONSTRAINT councillor_highlights_person_id_key UNIQUE (person_id);

--
-- Name: councillor_highlights councillor_highlights_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.councillor_highlights
    ADD CONSTRAINT councillor_highlights_pkey PRIMARY KEY (id);

--
-- Name: councillor_stances councillor_stances_person_id_topic_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.councillor_stances
    ADD CONSTRAINT councillor_stances_person_id_topic_key UNIQUE (person_id, topic);

--
-- Name: councillor_stances councillor_stances_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.councillor_stances
    ADD CONSTRAINT councillor_stances_pkey PRIMARY KEY (id);

--
-- Name: data_reports data_reports_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.data_reports
    ADD CONSTRAINT data_reports_pkey PRIMARY KEY (id);

--
-- Name: document_images document_images_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_images
    ADD CONSTRAINT document_images_pkey PRIMARY KEY (id);

--
-- Name: document_sections document_sections_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_sections
    ADD CONSTRAINT document_sections_pkey PRIMARY KEY (id);

--
-- Name: documents documents_meeting_id_file_path_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.documents
    ADD CONSTRAINT documents_meeting_id_file_path_key UNIQUE (meeting_id, file_path);

--
-- Name: documents documents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.documents
    ADD CONSTRAINT documents_pkey PRIMARY KEY (id);

--
-- Name: election_offices election_offices_election_id_office_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.election_offices
    ADD CONSTRAINT election_offices_election_id_office_key UNIQUE (election_id, office);

--
-- Name: election_offices election_offices_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.election_offices
    ADD CONSTRAINT election_offices_pkey PRIMARY KEY (id);

--
-- Name: elections elections_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.elections
    ADD CONSTRAINT elections_name_key UNIQUE (name);

--
-- Name: elections elections_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.elections
    ADD CONSTRAINT elections_pkey PRIMARY KEY (id);

--
-- Name: email_enqueue_receipts email_enqueue_receipts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_enqueue_receipts
    ADD CONSTRAINT email_enqueue_receipts_pkey PRIMARY KEY (meeting_id);

--
-- Name: email_events email_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_events
    ADD CONSTRAINT email_events_pkey PRIMARY KEY (id);

--
-- Name: email_events email_events_provider_event_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_events
    ADD CONSTRAINT email_events_provider_event_id_key UNIQUE (provider_event_id);

--
-- Name: email_messages email_messages_deduplication_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_messages
    ADD CONSTRAINT email_messages_deduplication_key_key UNIQUE (deduplication_key);

--
-- Name: email_messages email_messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_messages
    ADD CONSTRAINT email_messages_pkey PRIMARY KEY (id);

--
-- Name: email_messages email_messages_provider_message_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_messages
    ADD CONSTRAINT email_messages_provider_message_id_key UNIQUE (provider_message_id);

--
-- Name: email_suppressions email_suppressions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_suppressions
    ADD CONSTRAINT email_suppressions_pkey PRIMARY KEY (recipient);

--
-- Name: extracted_documents extracted_documents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.extracted_documents
    ADD CONSTRAINT extracted_documents_pkey PRIMARY KEY (id);

--
-- Name: hidden_pages hidden_pages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hidden_pages
    ADD CONSTRAINT hidden_pages_pkey PRIMARY KEY (record_table, record_id);

--
-- Name: key_statements key_statements_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.key_statements
    ADD CONSTRAINT key_statements_pkey PRIMARY KEY (id);

--
-- Name: key_votes key_votes_person_id_motion_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.key_votes
    ADD CONSTRAINT key_votes_person_id_motion_id_key UNIQUE (person_id, motion_id);

--
-- Name: key_votes key_votes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.key_votes
    ADD CONSTRAINT key_votes_pkey PRIMARY KEY (id);

--
-- Name: matter_evidence matter_evidence_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.matter_evidence
    ADD CONSTRAINT matter_evidence_pkey PRIMARY KEY (id);

--
-- Name: matter_links matter_links_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.matter_links
    ADD CONSTRAINT matter_links_pkey PRIMARY KEY (id);

--
-- Name: matter_merge_proposals matter_merge_proposals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.matter_merge_proposals
    ADD CONSTRAINT matter_merge_proposals_pkey PRIMARY KEY (id);

--
-- Name: matter_merges matter_merges_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.matter_merges
    ADD CONSTRAINT matter_merges_pkey PRIMARY KEY (id);

--
-- Name: matter_report_mentions matter_report_mentions_matter_id_report_id_page_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.matter_report_mentions
    ADD CONSTRAINT matter_report_mentions_matter_id_report_id_page_key UNIQUE (matter_id, report_id, page);

--
-- Name: matter_report_mentions matter_report_mentions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.matter_report_mentions
    ADD CONSTRAINT matter_report_mentions_pkey PRIMARY KEY (id);

--
-- Name: matters matters_identifier_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.matters
    ADD CONSTRAINT matters_identifier_key UNIQUE (identifier);

--
-- Name: matters matters_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.matters
    ADD CONSTRAINT matters_pkey PRIMARY KEY (id);

--
-- Name: meeting_events meeting_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meeting_events
    ADD CONSTRAINT meeting_events_pkey PRIMARY KEY (id);

--
-- Name: meeting_slug_history meeting_slug_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meeting_slug_history
    ADD CONSTRAINT meeting_slug_history_pkey PRIMARY KEY (id);

--
-- Name: meeting_speaker_aliases meeting_speaker_aliases_meeting_id_speaker_label_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meeting_speaker_aliases
    ADD CONSTRAINT meeting_speaker_aliases_meeting_id_speaker_label_key UNIQUE (meeting_id, speaker_label);

--
-- Name: meeting_speaker_aliases meeting_speaker_aliases_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meeting_speaker_aliases
    ADD CONSTRAINT meeting_speaker_aliases_pkey PRIMARY KEY (id);

--
-- Name: meetings meetings_archive_path_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meetings
    ADD CONSTRAINT meetings_archive_path_key UNIQUE (archive_path);

--
-- Name: meetings meetings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meetings
    ADD CONSTRAINT meetings_pkey PRIMARY KEY (id);

--
-- Name: memberships memberships_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memberships
    ADD CONSTRAINT memberships_pkey PRIMARY KEY (id);

--
-- Name: motions motions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.motions
    ADD CONSTRAINT motions_pkey PRIMARY KEY (id);

--
-- Name: municipalities municipalities_ocd_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.municipalities
    ADD CONSTRAINT municipalities_ocd_id_key UNIQUE (ocd_id);

--
-- Name: municipalities municipalities_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.municipalities
    ADD CONSTRAINT municipalities_pkey PRIMARY KEY (id);

--
-- Name: municipalities municipalities_slug_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.municipalities
    ADD CONSTRAINT municipalities_slug_key UNIQUE (slug);

--
-- Name: ocd_divisions ocd_divisions_division_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ocd_divisions
    ADD CONSTRAINT ocd_divisions_division_id_key UNIQUE (division_id);

--
-- Name: ocd_divisions ocd_divisions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ocd_divisions
    ADD CONSTRAINT ocd_divisions_pkey PRIMARY KEY (id);

--
-- Name: organizations organizations_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organizations
    ADD CONSTRAINT organizations_name_key UNIQUE (name);

--
-- Name: organizations organizations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organizations
    ADD CONSTRAINT organizations_pkey PRIMARY KEY (id);

--
-- Name: page_reviews page_reviews_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.page_reviews
    ADD CONSTRAINT page_reviews_pkey PRIMARY KEY (path);

--
-- Name: people people_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.people
    ADD CONSTRAINT people_name_key UNIQUE (name);

--
-- Name: people people_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.people
    ADD CONSTRAINT people_pkey PRIMARY KEY (id);

--
-- Name: pipeline_jobs pipeline_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pipeline_jobs
    ADD CONSTRAINT pipeline_jobs_pkey PRIMARY KEY (id);

--
-- Name: pipeline_run_events pipeline_run_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pipeline_run_events
    ADD CONSTRAINT pipeline_run_events_pkey PRIMARY KEY (id);

--
-- Name: properties properties_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.properties
    ADD CONSTRAINT properties_pkey PRIMARY KEY (id);

--
-- Name: properties properties_slug_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.properties
    ADD CONSTRAINT properties_slug_key UNIQUE (slug);

--
-- Name: property_links property_links_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.property_links
    ADD CONSTRAINT property_links_pkey PRIMARY KEY (id);

--
-- Name: public_content_version public_content_version_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.public_content_version
    ADD CONSTRAINT public_content_version_pkey PRIMARY KEY (id);

--
-- Name: public_report_pages public_report_pages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.public_report_pages
    ADD CONSTRAINT public_report_pages_pkey PRIMARY KEY (report_id, page);

--
-- Name: public_reports public_reports_municipality_id_kind_year_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.public_reports
    ADD CONSTRAINT public_reports_municipality_id_kind_year_key UNIQUE (municipality_id, kind, year);

--
-- Name: public_reports public_reports_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.public_reports
    ADD CONSTRAINT public_reports_pkey PRIMARY KEY (id);

--
-- Name: public_speaker_names public_speaker_names_agenda_item_id_name_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.public_speaker_names
    ADD CONSTRAINT public_speaker_names_agenda_item_id_name_key_key UNIQUE (agenda_item_id, name_key);

--
-- Name: public_speaker_names public_speaker_names_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.public_speaker_names
    ADD CONSTRAINT public_speaker_names_pkey PRIMARY KEY (id);

--
-- Name: rag_feedback rag_feedback_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rag_feedback
    ADD CONSTRAINT rag_feedback_pkey PRIMARY KEY (id);

--
-- Name: rag_traces rag_traces_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rag_traces
    ADD CONSTRAINT rag_traces_pkey PRIMARY KEY (id);

--
-- Name: review_examples review_examples_path_entry_key_problem_reason_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.review_examples
    ADD CONSTRAINT review_examples_path_entry_key_problem_reason_key UNIQUE (path, entry_key, problem, reason);

--
-- Name: review_examples review_examples_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.review_examples
    ADD CONSTRAINT review_examples_pkey PRIMARY KEY (id);

--
-- Name: review_guidance review_guidance_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.review_guidance
    ADD CONSTRAINT review_guidance_pkey PRIMARY KEY (id);

--
-- Name: search_daily_usage search_daily_usage_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.search_daily_usage
    ADD CONSTRAINT search_daily_usage_pkey PRIMARY KEY (day);

--
-- Name: search_results_cache search_results_cache_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.search_results_cache
    ADD CONSTRAINT search_results_cache_pkey PRIMARY KEY (id);

--
-- Name: server_metrics server_metrics_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.server_metrics
    ADD CONSTRAINT server_metrics_pkey PRIMARY KEY (sampled_at);

--
-- Name: source_meetings source_meetings_municipality_id_source_type_source_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_meetings
    ADD CONSTRAINT source_meetings_municipality_id_source_type_source_id_key UNIQUE (municipality_id, source_type, source_id);

--
-- Name: source_meetings source_meetings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_meetings
    ADD CONSTRAINT source_meetings_pkey PRIMARY KEY (id);

--
-- Name: staff_actions staff_actions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_actions
    ADD CONSTRAINT staff_actions_pkey PRIMARY KEY (id);

--
-- Name: subscriptions subscriptions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscriptions
    ADD CONSTRAINT subscriptions_pkey PRIMARY KEY (id);

--
-- Name: subscriptions subscriptions_unique_target; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscriptions
    ADD CONSTRAINT subscriptions_unique_target UNIQUE (user_id, type, matter_id, topic_id, person_id, neighborhood, keyword);

--
-- Name: topics topics_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.topics
    ADD CONSTRAINT topics_name_key UNIQUE (name);

--
-- Name: topics topics_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.topics
    ADD CONSTRAINT topics_pkey PRIMARY KEY (id);

--
-- Name: transcript_identity_evidence transcript_identity_evidence_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transcript_identity_evidence
    ADD CONSTRAINT transcript_identity_evidence_pkey PRIMARY KEY (id);

--
-- Name: transcript_identity_evidence transcript_identity_evidence_segment_id_input_sha256_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transcript_identity_evidence
    ADD CONSTRAINT transcript_identity_evidence_segment_id_input_sha256_key UNIQUE (segment_id, input_sha256);

--
-- Name: transcript_identity_evidence transcript_identity_evidence_segment_id_validator_sha256_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transcript_identity_evidence
    ADD CONSTRAINT transcript_identity_evidence_segment_id_validator_sha256_id_key UNIQUE (segment_id, validator_sha256, identity_evidence_sha256, source_run);

--
-- Name: transcript_segments transcript_segments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transcript_segments
    ADD CONSTRAINT transcript_segments_pkey PRIMARY KEY (id);

--
-- Name: user_profiles user_profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_profiles
    ADD CONSTRAINT user_profiles_pkey PRIMARY KEY (id);

--
-- Name: user_roles user_roles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_roles
    ADD CONSTRAINT user_roles_pkey PRIMARY KEY (user_id);

--
-- Name: voice_exemplars voice_exemplars_meeting_id_speaker_label_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.voice_exemplars
    ADD CONSTRAINT voice_exemplars_meeting_id_speaker_label_key UNIQUE (meeting_id, speaker_label);

--
-- Name: voice_exemplars voice_exemplars_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.voice_exemplars
    ADD CONSTRAINT voice_exemplars_pkey PRIMARY KEY (id);

--
-- Name: voice_fingerprints voice_fingerprints_person_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.voice_fingerprints
    ADD CONSTRAINT voice_fingerprints_person_id_key UNIQUE (person_id);

--
-- Name: voice_fingerprints voice_fingerprints_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.voice_fingerprints
    ADD CONSTRAINT voice_fingerprints_pkey PRIMARY KEY (id);

--
-- Name: votes votes_motion_id_person_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.votes
    ADD CONSTRAINT votes_motion_id_person_id_key UNIQUE (motion_id, person_id);

--
-- Name: votes votes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.votes
    ADD CONSTRAINT votes_pkey PRIMARY KEY (id);

--
-- Name: agenda_items_matter_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX agenda_items_matter_id_idx ON public.agenda_items USING btree (matter_id) WHERE (matter_id IS NOT NULL);

--
-- Name: agenda_items_parent_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX agenda_items_parent_id_idx ON public.agenda_items USING btree (parent_id) WHERE (parent_id IS NOT NULL);

--
-- Name: ai_usage_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ai_usage_created_at_idx ON public.ai_usage USING btree (created_at DESC);

--
-- Name: ai_usage_failures_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ai_usage_failures_idx ON public.ai_usage USING btree (created_at DESC) WHERE (NOT ok);

--
-- Name: ai_usage_pipeline_job_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ai_usage_pipeline_job_idx ON public.ai_usage USING btree (pipeline_job_id) WHERE (pipeline_job_id IS NOT NULL);

--
-- Name: ai_usage_stage_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ai_usage_stage_created_at_idx ON public.ai_usage USING btree (stage, created_at);

--
-- Name: attendance_person_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX attendance_person_id_idx ON public.attendance USING btree (person_id);

--
-- Name: bylaw_chunks_missing_embedding_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX bylaw_chunks_missing_embedding_idx ON public.bylaw_chunks USING btree (id) WHERE (embedding IS NULL);

--
-- Name: channel_posts_channel_updated_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX channel_posts_channel_updated_idx ON public.channel_posts USING btree (channel, updated_at DESC);

--
-- Name: data_reports_path_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX data_reports_path_idx ON public.data_reports USING btree (path);

--
-- Name: data_reports_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX data_reports_status_idx ON public.data_reports USING btree (status, created_at DESC);

--
-- Name: data_reports_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX data_reports_user_idx ON public.data_reports USING btree (user_id, created_at DESC);

--
-- Name: document_sections_missing_embedding_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX document_sections_missing_embedding_idx ON public.document_sections USING btree (id) WHERE (embedding IS NULL);

--
-- Name: email_events_message_time_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX email_events_message_time_idx ON public.email_events USING btree (message_id, occurred_at DESC, id DESC);

--
-- Name: email_messages_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX email_messages_created_idx ON public.email_messages USING btree (created_at DESC, id DESC);

--
-- Name: email_messages_pending_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX email_messages_pending_idx ON public.email_messages USING btree (next_attempt_at, created_at) WHERE (status = ANY (ARRAY['queued'::text, 'attempting'::text]));

--
-- Name: email_messages_status_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX email_messages_status_created_idx ON public.email_messages USING btree (status, created_at DESC, id DESC);

--
-- Name: email_messages_unsubscribe_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX email_messages_unsubscribe_idx ON public.email_messages USING btree (unsubscribe_token);

--
-- Name: email_messages_user_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX email_messages_user_created_idx ON public.email_messages USING btree (user_id, created_at DESC, id DESC);

--
-- Name: idx_agenda_items_fts; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agenda_items_fts ON public.agenda_items USING gin (text_search);

--
-- Name: idx_agenda_items_meeting; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agenda_items_meeting ON public.agenda_items USING btree (meeting_id);

--
-- Name: idx_agenda_items_slug; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_agenda_items_slug ON public.agenda_items USING btree (slug);

--
-- Name: idx_agenda_neighborhood; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agenda_neighborhood ON public.agenda_items USING btree (neighborhood);

--
-- Name: idx_api_keys_prefix_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_api_keys_prefix_active ON public.api_keys USING btree (key_prefix, is_active) WHERE (is_active = true);

--
-- Name: idx_api_keys_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_api_keys_user_id ON public.api_keys USING btree (user_id);

--
-- Name: idx_bylaw_chunks_bylaw_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bylaw_chunks_bylaw_id ON public.bylaw_chunks USING btree (bylaw_id);

--
-- Name: idx_bylaw_chunks_embedding; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bylaw_chunks_embedding ON public.bylaw_chunks USING hnsw (embedding public.halfvec_cosine_ops);

--
-- Name: idx_bylaw_chunks_fts; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bylaw_chunks_fts ON public.bylaw_chunks USING gin (text_search);

--
-- Name: idx_bylaws_embedding; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bylaws_embedding ON public.bylaws USING hnsw (embedding public.halfvec_cosine_ops);

--
-- Name: idx_bylaws_municipality_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bylaws_municipality_id ON public.bylaws USING btree (municipality_id);

--
-- Name: idx_bylaws_number; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bylaws_number ON public.bylaws USING btree (bylaw_number);

--
-- Name: idx_bylaws_slug_muni; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_bylaws_slug_muni ON public.bylaws USING btree (slug, municipality_id) WHERE (slug IS NOT NULL);

--
-- Name: idx_bylaws_title; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bylaws_title ON public.bylaws USING btree (title);

--
-- Name: idx_contact_messages_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_contact_messages_created_at ON public.contact_messages USING btree (created_at DESC);

--
-- Name: idx_contact_messages_open; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_contact_messages_open ON public.contact_messages USING btree (created_at DESC) WHERE (handled_at IS NULL);

--
-- Name: idx_council_terms_election_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_council_terms_election_id ON public.council_terms USING btree (election_id);

--
-- Name: idx_document_images_extracted_doc; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_document_images_extracted_doc ON public.document_images USING btree (extracted_document_id);

--
-- Name: idx_document_images_section; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_document_images_section ON public.document_images USING btree (document_section_id);

--
-- Name: idx_document_sections_agenda_item; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_document_sections_agenda_item ON public.document_sections USING btree (agenda_item_id);

--
-- Name: idx_document_sections_document; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_document_sections_document ON public.document_sections USING btree (document_id);

--
-- Name: idx_document_sections_embedding; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_document_sections_embedding ON public.document_sections USING hnsw (embedding public.halfvec_cosine_ops);

--
-- Name: idx_document_sections_extracted_doc; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_document_sections_extracted_doc ON public.document_sections USING btree (extracted_document_id);

--
-- Name: idx_document_sections_search; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_document_sections_search ON public.document_sections USING gin (text_search);

--
-- Name: idx_documents_category; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_documents_category ON public.documents USING btree (category);

--
-- Name: idx_documents_meeting_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_documents_meeting_id ON public.documents USING btree (meeting_id);

--
-- Name: idx_documents_municipality_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_documents_municipality_id ON public.documents USING btree (municipality_id);

--
-- Name: idx_elections_slug; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_elections_slug ON public.elections USING btree (slug);

--
-- Name: idx_extracted_documents_agenda_item; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_extracted_documents_agenda_item ON public.extracted_documents USING btree (agenda_item_id);

--
-- Name: idx_extracted_documents_document; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_extracted_documents_document ON public.extracted_documents USING btree (document_id);

--
-- Name: idx_extracted_documents_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_extracted_documents_type ON public.extracted_documents USING btree (document_type);

--
-- Name: idx_key_statements_agenda_item_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_key_statements_agenda_item_id ON public.key_statements USING btree (agenda_item_id);

--
-- Name: idx_key_statements_embedding; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_key_statements_embedding ON public.key_statements USING hnsw (embedding public.halfvec_cosine_ops);

--
-- Name: idx_key_statements_fts; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_key_statements_fts ON public.key_statements USING gin (text_search);

--
-- Name: idx_key_statements_meeting_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_key_statements_meeting_id ON public.key_statements USING btree (meeting_id);

--
-- Name: idx_key_statements_municipality_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_key_statements_municipality_id ON public.key_statements USING btree (municipality_id);

--
-- Name: idx_key_statements_person; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_key_statements_person ON public.key_statements USING btree (person_id);

--
-- Name: idx_key_statements_person_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_key_statements_person_id ON public.key_statements USING btree (person_id);

--
-- Name: idx_key_statements_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_key_statements_type ON public.key_statements USING btree (statement_type);

--
-- Name: idx_matter_evidence_agenda_item_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_matter_evidence_agenda_item_id ON public.matter_evidence USING btree (agenda_item_id);

--
-- Name: idx_matter_evidence_document_section_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_matter_evidence_document_section_id ON public.matter_evidence USING btree (document_section_id);

--
-- Name: idx_matter_evidence_matter_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_matter_evidence_matter_id ON public.matter_evidence USING btree (matter_id);

--
-- Name: idx_matter_evidence_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_matter_evidence_unique ON public.matter_evidence USING btree (matter_id, COALESCE(agenda_item_id, (0)::bigint), COALESCE(document_section_id, (0)::bigint), evidence_type);

--
-- Name: idx_matters_bylaw_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_matters_bylaw_id ON public.matters USING btree (bylaw_id);

--
-- Name: idx_matters_embedding; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_matters_embedding ON public.matters USING hnsw (embedding public.halfvec_cosine_ops);

--
-- Name: idx_matters_fts; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_matters_fts ON public.matters USING gin (text_search);

--
-- Name: idx_matters_municipality_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_matters_municipality_id ON public.matters USING btree (municipality_id);

--
-- Name: idx_matters_slug_muni; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_matters_slug_muni ON public.matters USING btree (slug, municipality_id) WHERE (slug IS NOT NULL);

--
-- Name: idx_meeting_slug_history_meeting; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_meeting_slug_history_meeting ON public.meeting_slug_history USING btree (meeting_id);

--
-- Name: idx_meeting_slug_history_slug_muni; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_meeting_slug_history_slug_muni ON public.meeting_slug_history USING btree (old_slug, municipality_id);

--
-- Name: idx_meetings_embedding; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_meetings_embedding ON public.meetings USING hnsw (embedding public.halfvec_cosine_ops);

--
-- Name: idx_meetings_muni_date_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_meetings_muni_date_type ON public.meetings USING btree (municipality_id, meeting_date, type);

--
-- Name: idx_meetings_municipality_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_meetings_municipality_id ON public.meetings USING btree (municipality_id);

--
-- Name: idx_meetings_slug_muni; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_meetings_slug_muni ON public.meetings USING btree (slug, municipality_id) WHERE (slug IS NOT NULL);

--
-- Name: idx_memberships_council_term_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memberships_council_term_id ON public.memberships USING btree (council_term_id);

--
-- Name: idx_memberships_person_org_role_term; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_memberships_person_org_role_term ON public.memberships USING btree (person_id, organization_id, role, council_term_id) WHERE (council_term_id IS NOT NULL);

--
-- Name: idx_motions_agenda_item; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_motions_agenda_item ON public.motions USING btree (agenda_item_id);

--
-- Name: idx_motions_embedding; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_motions_embedding ON public.motions USING hnsw (embedding public.halfvec_cosine_ops);

--
-- Name: idx_motions_fts; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_motions_fts ON public.motions USING gin (text_search);

--
-- Name: idx_motions_meeting; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_motions_meeting ON public.motions USING btree (meeting_id);

--
-- Name: idx_motions_mover; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_motions_mover ON public.motions USING btree (mover_id);

--
-- Name: idx_motions_seconder; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_motions_seconder ON public.motions USING btree (seconder_id);

--
-- Name: idx_motions_slug; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_motions_slug ON public.motions USING btree (slug);

--
-- Name: idx_organizations_municipality_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_organizations_municipality_id ON public.organizations USING btree (municipality_id);

--
-- Name: idx_people_slug; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_people_slug ON public.people USING btree (slug);

--
-- Name: idx_pipeline_jobs_municipality_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pipeline_jobs_municipality_status ON public.pipeline_jobs USING btree (municipality_id, status);

--
-- Name: idx_pipeline_jobs_status_priority; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pipeline_jobs_status_priority ON public.pipeline_jobs USING btree (status, priority DESC, requested_at);

--
-- Name: idx_pipeline_run_events_job_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pipeline_run_events_job_created ON public.pipeline_run_events USING btree (job_id, created_at);

--
-- Name: idx_rag_feedback_anon; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_rag_feedback_anon ON public.rag_feedback USING btree (trace_id, client_ip) WHERE (user_id IS NULL);

--
-- Name: idx_rag_feedback_authed; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_rag_feedback_authed ON public.rag_feedback USING btree (trace_id, user_id) WHERE (user_id IS NOT NULL);

--
-- Name: idx_rag_feedback_trace_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_rag_feedback_trace_id ON public.rag_feedback USING btree (trace_id);

--
-- Name: idx_rag_traces_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_rag_traces_created_at ON public.rag_traces USING btree (created_at DESC);

--
-- Name: idx_search_cache_expires; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_search_cache_expires ON public.search_results_cache USING btree (expires_at);

--
-- Name: idx_search_cache_normalized; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_search_cache_normalized ON public.search_results_cache USING btree (normalized_query, created_at DESC) WHERE (normalized_query IS NOT NULL);

--
-- Name: idx_source_meetings_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_source_meetings_date ON public.source_meetings USING btree (meeting_date DESC);

--
-- Name: idx_source_meetings_ingested; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_source_meetings_ingested ON public.source_meetings USING btree (ingested_meeting_id);

--
-- Name: idx_source_meetings_municipality_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_source_meetings_municipality_status ON public.source_meetings USING btree (municipality_id, status);

--
-- Name: idx_subscriptions_active_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_subscriptions_active_type ON public.subscriptions USING btree (type, is_active);

--
-- Name: idx_subscriptions_keyword_embedding; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_subscriptions_keyword_embedding ON public.subscriptions USING hnsw (keyword_embedding public.halfvec_cosine_ops);

--
-- Name: idx_subscriptions_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_subscriptions_user_id ON public.subscriptions USING btree (user_id);

--
-- Name: idx_transcript_segments_meeting_start; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_transcript_segments_meeting_start ON public.transcript_segments USING btree (meeting_id, start_time);

--
-- Name: idx_transcript_segments_person; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_transcript_segments_person ON public.transcript_segments USING btree (person_id);

--
-- Name: idx_ts_segments_fts; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ts_segments_fts ON public.transcript_segments USING gin (text_search);

--
-- Name: idx_voice_fingerprints_person_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_voice_fingerprints_person_id ON public.voice_fingerprints USING btree (person_id);

--
-- Name: idx_voice_fingerprints_source_meeting_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_voice_fingerprints_source_meeting_id ON public.voice_fingerprints USING btree (source_meeting_id);

--
-- Name: idx_votes_person; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_votes_person ON public.votes USING btree (person_id);

--
-- Name: matter_links_matter_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matter_links_matter_idx ON public.matter_links USING btree (matter_id);

--
-- Name: matter_links_mention_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX matter_links_mention_uniq ON public.matter_links USING btree (matter_id, agenda_item_id) WHERE (kind = 'mention'::text);

--
-- Name: matter_links_related_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matter_links_related_idx ON public.matter_links USING btree (related_matter_id);

--
-- Name: matter_links_related_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX matter_links_related_uniq ON public.matter_links USING btree (LEAST(matter_id, related_matter_id), GREATEST(matter_id, related_matter_id)) WHERE (kind = 'related_matter'::text);

--
-- Name: matter_links_reviewed; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matter_links_reviewed ON public.matter_links USING btree (reviewed_at DESC) WHERE (review IS NOT NULL);

--
-- Name: matter_links_suggested; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matter_links_suggested ON public.matter_links USING btree (matter_id) WHERE ((suggested_at IS NOT NULL) AND (review IS NULL));

--
-- Name: matter_merge_proposals_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matter_merge_proposals_status_idx ON public.matter_merge_proposals USING btree (status, created_at DESC);

--
-- Name: matter_report_mentions_matter_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matter_report_mentions_matter_idx ON public.matter_report_mentions USING btree (matter_id);

--
-- Name: matters_merged_into_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matters_merged_into_idx ON public.matters USING btree (merged_into) WHERE (merged_into IS NOT NULL);

--
-- Name: meetings_calendar_source_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX meetings_calendar_source_unique ON public.meetings USING btree (calendar_source_id);

--
-- Name: meetings_organization_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX meetings_organization_id_idx ON public.meetings USING btree (organization_id);

--
-- Name: motions_canonical_source_identity; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX motions_canonical_source_identity ON public.motions USING btree (meeting_id, (((meta -> 'canonical_source_motion'::text) ->> 'key'::text))) WHERE (NULLIF(((meta -> 'canonical_source_motion'::text) ->> 'key'::text), ''::text) IS NOT NULL);

--
-- Name: page_reviews_check_queue; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX page_reviews_check_queue ON public.page_reviews USING btree (check_requested_at) WHERE (check_requested_at IS NOT NULL);

--
-- Name: page_reviews_checked; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX page_reviews_checked ON public.page_reviews USING btree (ai_checked_at DESC) WHERE (ai_checked_at IS NOT NULL);

--
-- Name: page_reviews_recent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX page_reviews_recent ON public.page_reviews USING btree (reviewed_at DESC);

--
-- Name: pipeline_run_events_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX pipeline_run_events_created_at_idx ON public.pipeline_run_events USING btree (created_at);

--
-- Name: properties_street_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX properties_street_idx ON public.properties USING btree (lower(street));

--
-- Name: properties_visible_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX properties_visible_idx ON public.properties USING btree (id) WHERE (NOT hidden);

--
-- Name: property_links_item_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX property_links_item_idx ON public.property_links USING btree (agenda_item_id);

--
-- Name: property_links_item_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX property_links_item_uniq ON public.property_links USING btree (property_id, agenda_item_id) WHERE (agenda_item_id IS NOT NULL);

--
-- Name: property_links_matter_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX property_links_matter_idx ON public.property_links USING btree (matter_id);

--
-- Name: property_links_matter_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX property_links_matter_uniq ON public.property_links USING btree (property_id, matter_id) WHERE (agenda_item_id IS NULL);

--
-- Name: public_report_pages_search; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX public_report_pages_search ON public.public_report_pages USING gin (text_search);

--
-- Name: public_speaker_names_meeting_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX public_speaker_names_meeting_idx ON public.public_speaker_names USING btree (meeting_id);

--
-- Name: public_speaker_names_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX public_speaker_names_status_idx ON public.public_speaker_names USING btree (status, created_at);

--
-- Name: review_examples_embedding; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX review_examples_embedding ON public.review_examples USING hnsw (embedding public.halfvec_cosine_ops);

--
-- Name: review_examples_kind_problem; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX review_examples_kind_problem ON public.review_examples USING btree (page_kind, problem);

--
-- Name: review_guidance_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX review_guidance_status ON public.review_guidance USING btree (status, problem);

--
-- Name: search_results_cache_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX search_results_cache_created_at_idx ON public.search_results_cache USING btree (created_at DESC);

--
-- Name: staff_actions_recent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX staff_actions_recent ON public.staff_actions USING btree (created_at DESC);

--
-- Name: staff_actions_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX staff_actions_user ON public.staff_actions USING btree (user_id, created_at DESC);

--
-- Name: transcript_identity_evidence_meeting_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX transcript_identity_evidence_meeting_idx ON public.transcript_identity_evidence USING btree (meeting_id, created_at);

--
-- Name: transcript_segments_agenda_item_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX transcript_segments_agenda_item_id_idx ON public.transcript_segments USING btree (agenda_item_id) WHERE (agenda_item_id IS NOT NULL);

--
-- Name: transcript_segments_motion_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX transcript_segments_motion_id_idx ON public.transcript_segments USING btree (motion_id) WHERE (motion_id IS NOT NULL);

--
-- Name: transcript_segments_person_appearance_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX transcript_segments_person_appearance_idx ON public.transcript_segments USING btree (person_id, meeting_id, agenda_item_id, id) INCLUDE (start_time, end_time) WHERE (person_id IS NOT NULL);

--
-- Name: voice_exemplars_person_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX voice_exemplars_person_idx ON public.voice_exemplars USING btree (person_id);

--
-- Name: agenda_items drop_own_mention; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER drop_own_mention AFTER INSERT OR UPDATE OF matter_id ON public.agenda_items FOR EACH ROW WHEN ((new.matter_id IS NOT NULL)) EXECUTE FUNCTION public.drop_own_mention();

--
-- Name: matters flatten_matter_merge; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER flatten_matter_merge BEFORE INSERT OR UPDATE OF merged_into ON public.matters FOR EACH ROW EXECUTE FUNCTION public.flatten_matter_merge();

--
-- Name: agenda_items redirect_merged_matter; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER redirect_merged_matter BEFORE INSERT OR UPDATE OF matter_id ON public.agenda_items FOR EACH ROW EXECUTE FUNCTION public.redirect_merged_matter();

--
-- Name: matter_evidence redirect_merged_matter; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER redirect_merged_matter BEFORE INSERT OR UPDATE OF matter_id ON public.matter_evidence FOR EACH ROW EXECUTE FUNCTION public.redirect_merged_matter();

--
-- Name: matter_links redirect_merged_matter; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER redirect_merged_matter BEFORE INSERT OR UPDATE OF matter_id, related_matter_id ON public.matter_links FOR EACH ROW EXECUTE FUNCTION public.redirect_merged_matter_link();

--
-- Name: matter_report_mentions redirect_merged_matter; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER redirect_merged_matter BEFORE INSERT OR UPDATE OF matter_id ON public.matter_report_mentions FOR EACH ROW EXECUTE FUNCTION public.redirect_merged_matter();

--
-- Name: property_links redirect_merged_matter; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER redirect_merged_matter BEFORE INSERT OR UPDATE OF matter_id ON public.property_links FOR EACH ROW EXECUTE FUNCTION public.redirect_merged_matter();

--
-- Name: subscriptions redirect_merged_matter; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER redirect_merged_matter BEFORE INSERT OR UPDATE OF matter_id ON public.subscriptions FOR EACH ROW EXECUTE FUNCTION public.redirect_merged_matter();

--
-- Name: matters repoint_matter_merges; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER repoint_matter_merges AFTER UPDATE OF merged_into ON public.matters FOR EACH ROW WHEN ((new.merged_into IS DISTINCT FROM old.merged_into)) EXECUTE FUNCTION public.repoint_matter_merges();

--
-- Name: agenda_items set_timestamp_agenda_items; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_timestamp_agenda_items BEFORE UPDATE ON public.agenda_items FOR EACH ROW EXECUTE FUNCTION public.update_timestamp();

--
-- Name: attendance set_timestamp_attendance; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_timestamp_attendance BEFORE UPDATE ON public.attendance FOR EACH ROW EXECUTE FUNCTION public.update_timestamp();

--
-- Name: bylaws set_timestamp_bylaws; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_timestamp_bylaws BEFORE UPDATE ON public.bylaws FOR EACH ROW EXECUTE FUNCTION public.update_timestamp();

--
-- Name: candidacies set_timestamp_candidacies; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_timestamp_candidacies BEFORE UPDATE ON public.candidacies FOR EACH ROW EXECUTE FUNCTION public.update_timestamp();

--
-- Name: council_terms set_timestamp_council_terms; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_timestamp_council_terms BEFORE UPDATE ON public.council_terms FOR EACH ROW EXECUTE FUNCTION public.update_timestamp();

--
-- Name: documents set_timestamp_documents; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_timestamp_documents BEFORE UPDATE ON public.documents FOR EACH ROW EXECUTE FUNCTION public.update_timestamp();

--
-- Name: election_offices set_timestamp_election_offices; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_timestamp_election_offices BEFORE UPDATE ON public.election_offices FOR EACH ROW EXECUTE FUNCTION public.update_timestamp();

--
-- Name: elections set_timestamp_elections; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_timestamp_elections BEFORE UPDATE ON public.elections FOR EACH ROW EXECUTE FUNCTION public.update_timestamp();

--
-- Name: key_statements set_timestamp_key_statements; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_timestamp_key_statements BEFORE UPDATE ON public.key_statements FOR EACH ROW EXECUTE FUNCTION public.update_timestamp();

--
-- Name: matter_evidence set_timestamp_matter_evidence; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_timestamp_matter_evidence BEFORE UPDATE ON public.matter_evidence FOR EACH ROW EXECUTE FUNCTION public.update_timestamp();

--
-- Name: matters set_timestamp_matters; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_timestamp_matters BEFORE UPDATE ON public.matters FOR EACH ROW EXECUTE FUNCTION public.update_timestamp();

--
-- Name: meeting_events set_timestamp_meeting_events; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_timestamp_meeting_events BEFORE UPDATE ON public.meeting_events FOR EACH ROW EXECUTE FUNCTION public.update_timestamp();

--
-- Name: meeting_speaker_aliases set_timestamp_meeting_speaker_aliases; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_timestamp_meeting_speaker_aliases BEFORE UPDATE ON public.meeting_speaker_aliases FOR EACH ROW EXECUTE FUNCTION public.update_timestamp();

--
-- Name: meetings set_timestamp_meetings; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_timestamp_meetings BEFORE UPDATE ON public.meetings FOR EACH ROW EXECUTE FUNCTION public.update_timestamp();

--
-- Name: memberships set_timestamp_memberships; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_timestamp_memberships BEFORE UPDATE ON public.memberships FOR EACH ROW EXECUTE FUNCTION public.update_timestamp();

--
-- Name: motions set_timestamp_motions; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_timestamp_motions BEFORE UPDATE ON public.motions FOR EACH ROW EXECUTE FUNCTION public.update_timestamp();

--
-- Name: municipalities set_timestamp_municipalities; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_timestamp_municipalities BEFORE UPDATE ON public.municipalities FOR EACH ROW EXECUTE FUNCTION public.update_timestamp();

--
-- Name: organizations set_timestamp_organizations; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_timestamp_organizations BEFORE UPDATE ON public.organizations FOR EACH ROW EXECUTE FUNCTION public.update_timestamp();

--
-- Name: people set_timestamp_people; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_timestamp_people BEFORE UPDATE ON public.people FOR EACH ROW EXECUTE FUNCTION public.update_timestamp();

--
-- Name: pipeline_jobs set_timestamp_pipeline_jobs; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_timestamp_pipeline_jobs BEFORE UPDATE ON public.pipeline_jobs FOR EACH ROW EXECUTE FUNCTION public.update_timestamp();

--
-- Name: public_reports set_timestamp_public_reports; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_timestamp_public_reports BEFORE UPDATE ON public.public_reports FOR EACH ROW EXECUTE FUNCTION public.update_timestamp();

--
-- Name: source_meetings set_timestamp_source_meetings; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_timestamp_source_meetings BEFORE UPDATE ON public.source_meetings FOR EACH ROW EXECUTE FUNCTION public.update_timestamp();

--
-- Name: subscriptions set_timestamp_subscriptions; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_timestamp_subscriptions BEFORE UPDATE ON public.subscriptions FOR EACH ROW EXECUTE FUNCTION public.update_timestamp();

--
-- Name: topics set_timestamp_topics; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_timestamp_topics BEFORE UPDATE ON public.topics FOR EACH ROW EXECUTE FUNCTION public.update_timestamp();

--
-- Name: transcript_segments set_timestamp_transcript_segments; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_timestamp_transcript_segments BEFORE UPDATE ON public.transcript_segments FOR EACH ROW EXECUTE FUNCTION public.update_timestamp();

--
-- Name: user_profiles set_timestamp_user_profiles; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_timestamp_user_profiles BEFORE UPDATE ON public.user_profiles FOR EACH ROW EXECUTE FUNCTION public.update_timestamp();

--
-- Name: voice_exemplars set_timestamp_voice_exemplars; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_timestamp_voice_exemplars BEFORE UPDATE ON public.voice_exemplars FOR EACH ROW EXECUTE FUNCTION public.update_timestamp();

--
-- Name: voice_fingerprints set_timestamp_voice_fingerprints; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_timestamp_voice_fingerprints BEFORE UPDATE ON public.voice_fingerprints FOR EACH ROW EXECUTE FUNCTION public.update_timestamp();

--
-- Name: votes set_timestamp_votes; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_timestamp_votes BEFORE UPDATE ON public.votes FOR EACH ROW EXECUTE FUNCTION public.update_timestamp();

--
-- Name: matter_links skip_own_mention; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER skip_own_mention BEFORE INSERT OR UPDATE OF matter_id, agenda_item_id ON public.matter_links FOR EACH ROW EXECUTE FUNCTION public.skip_own_mention();

--
-- Name: agenda_item_topics touch_public_content_version; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER touch_public_content_version AFTER INSERT OR DELETE OR UPDATE OR TRUNCATE ON public.agenda_item_topics FOR EACH STATEMENT EXECUTE FUNCTION public.touch_public_content_version();

--
-- Name: agenda_items touch_public_content_version; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER touch_public_content_version AFTER INSERT OR DELETE OR UPDATE OR TRUNCATE ON public.agenda_items FOR EACH STATEMENT EXECUTE FUNCTION public.touch_public_content_version();

--
-- Name: attendance touch_public_content_version; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER touch_public_content_version AFTER INSERT OR DELETE OR UPDATE OR TRUNCATE ON public.attendance FOR EACH STATEMENT EXECUTE FUNCTION public.touch_public_content_version();

--
-- Name: bylaws touch_public_content_version; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER touch_public_content_version AFTER INSERT OR DELETE OR UPDATE OR TRUNCATE ON public.bylaws FOR EACH STATEMENT EXECUTE FUNCTION public.touch_public_content_version();

--
-- Name: candidacies touch_public_content_version; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER touch_public_content_version AFTER INSERT OR DELETE OR UPDATE OR TRUNCATE ON public.candidacies FOR EACH STATEMENT EXECUTE FUNCTION public.touch_public_content_version();

--
-- Name: council_terms touch_public_content_version; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER touch_public_content_version AFTER INSERT OR DELETE OR UPDATE OR TRUNCATE ON public.council_terms FOR EACH STATEMENT EXECUTE FUNCTION public.touch_public_content_version();

--
-- Name: councillor_highlights touch_public_content_version; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER touch_public_content_version AFTER INSERT OR DELETE OR UPDATE OR TRUNCATE ON public.councillor_highlights FOR EACH STATEMENT EXECUTE FUNCTION public.touch_public_content_version();

--
-- Name: councillor_stances touch_public_content_version; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER touch_public_content_version AFTER INSERT OR DELETE OR UPDATE OR TRUNCATE ON public.councillor_stances FOR EACH STATEMENT EXECUTE FUNCTION public.touch_public_content_version();

--
-- Name: document_images touch_public_content_version; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER touch_public_content_version AFTER INSERT OR DELETE OR UPDATE OR TRUNCATE ON public.document_images FOR EACH STATEMENT EXECUTE FUNCTION public.touch_public_content_version();

--
-- Name: document_sections touch_public_content_version; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER touch_public_content_version AFTER INSERT OR DELETE OR UPDATE OR TRUNCATE ON public.document_sections FOR EACH STATEMENT EXECUTE FUNCTION public.touch_public_content_version();

--
-- Name: documents touch_public_content_version; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER touch_public_content_version AFTER INSERT OR DELETE OR UPDATE OR TRUNCATE ON public.documents FOR EACH STATEMENT EXECUTE FUNCTION public.touch_public_content_version();

--
-- Name: election_offices touch_public_content_version; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER touch_public_content_version AFTER INSERT OR DELETE OR UPDATE OR TRUNCATE ON public.election_offices FOR EACH STATEMENT EXECUTE FUNCTION public.touch_public_content_version();

--
-- Name: elections touch_public_content_version; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER touch_public_content_version AFTER INSERT OR DELETE OR UPDATE OR TRUNCATE ON public.elections FOR EACH STATEMENT EXECUTE FUNCTION public.touch_public_content_version();

--
-- Name: extracted_documents touch_public_content_version; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER touch_public_content_version AFTER INSERT OR DELETE OR UPDATE OR TRUNCATE ON public.extracted_documents FOR EACH STATEMENT EXECUTE FUNCTION public.touch_public_content_version();

--
-- Name: key_statements touch_public_content_version; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER touch_public_content_version AFTER INSERT OR DELETE OR UPDATE OR TRUNCATE ON public.key_statements FOR EACH STATEMENT EXECUTE FUNCTION public.touch_public_content_version();

--
-- Name: key_votes touch_public_content_version; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER touch_public_content_version AFTER INSERT OR DELETE OR UPDATE OR TRUNCATE ON public.key_votes FOR EACH STATEMENT EXECUTE FUNCTION public.touch_public_content_version();

--
-- Name: matter_evidence touch_public_content_version; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER touch_public_content_version AFTER INSERT OR DELETE OR UPDATE OR TRUNCATE ON public.matter_evidence FOR EACH STATEMENT EXECUTE FUNCTION public.touch_public_content_version();

--
-- Name: matter_links touch_public_content_version; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER touch_public_content_version AFTER INSERT OR DELETE OR UPDATE OR TRUNCATE ON public.matter_links FOR EACH STATEMENT EXECUTE FUNCTION public.touch_public_content_version();

--
-- Name: matter_report_mentions touch_public_content_version; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER touch_public_content_version AFTER INSERT OR DELETE OR UPDATE OR TRUNCATE ON public.matter_report_mentions FOR EACH STATEMENT EXECUTE FUNCTION public.touch_public_content_version();

--
-- Name: matters touch_public_content_version; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER touch_public_content_version AFTER INSERT OR DELETE OR UPDATE OR TRUNCATE ON public.matters FOR EACH STATEMENT EXECUTE FUNCTION public.touch_public_content_version();

--
-- Name: meeting_events touch_public_content_version; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER touch_public_content_version AFTER INSERT OR DELETE OR UPDATE OR TRUNCATE ON public.meeting_events FOR EACH STATEMENT EXECUTE FUNCTION public.touch_public_content_version();

--
-- Name: meeting_slug_history touch_public_content_version; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER touch_public_content_version AFTER INSERT OR DELETE OR UPDATE OR TRUNCATE ON public.meeting_slug_history FOR EACH STATEMENT EXECUTE FUNCTION public.touch_public_content_version();

--
-- Name: meeting_speaker_aliases touch_public_content_version; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER touch_public_content_version AFTER INSERT OR DELETE OR UPDATE OR TRUNCATE ON public.meeting_speaker_aliases FOR EACH STATEMENT EXECUTE FUNCTION public.touch_public_content_version();

--
-- Name: meetings touch_public_content_version; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER touch_public_content_version AFTER INSERT OR DELETE OR UPDATE OR TRUNCATE ON public.meetings FOR EACH STATEMENT EXECUTE FUNCTION public.touch_public_content_version();

--
-- Name: memberships touch_public_content_version; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER touch_public_content_version AFTER INSERT OR DELETE OR UPDATE OR TRUNCATE ON public.memberships FOR EACH STATEMENT EXECUTE FUNCTION public.touch_public_content_version();

--
-- Name: motions touch_public_content_version; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER touch_public_content_version AFTER INSERT OR DELETE OR UPDATE OR TRUNCATE ON public.motions FOR EACH STATEMENT EXECUTE FUNCTION public.touch_public_content_version();

--
-- Name: municipalities touch_public_content_version; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER touch_public_content_version AFTER INSERT OR DELETE OR UPDATE OR TRUNCATE ON public.municipalities FOR EACH STATEMENT EXECUTE FUNCTION public.touch_public_content_version();

--
-- Name: organizations touch_public_content_version; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER touch_public_content_version AFTER INSERT OR DELETE OR UPDATE OR TRUNCATE ON public.organizations FOR EACH STATEMENT EXECUTE FUNCTION public.touch_public_content_version();

--
-- Name: people touch_public_content_version; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER touch_public_content_version AFTER INSERT OR DELETE OR UPDATE OR TRUNCATE ON public.people FOR EACH STATEMENT EXECUTE FUNCTION public.touch_public_content_version();

--
-- Name: properties touch_public_content_version; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER touch_public_content_version AFTER INSERT OR DELETE OR UPDATE OR TRUNCATE ON public.properties FOR EACH STATEMENT EXECUTE FUNCTION public.touch_public_content_version();

--
-- Name: property_links touch_public_content_version; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER touch_public_content_version AFTER INSERT OR DELETE OR UPDATE OR TRUNCATE ON public.property_links FOR EACH STATEMENT EXECUTE FUNCTION public.touch_public_content_version();

--
-- Name: public_reports touch_public_content_version; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER touch_public_content_version AFTER INSERT OR DELETE OR UPDATE OR TRUNCATE ON public.public_reports FOR EACH STATEMENT EXECUTE FUNCTION public.touch_public_content_version();

--
-- Name: public_speaker_names touch_public_content_version; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER touch_public_content_version AFTER INSERT OR DELETE OR UPDATE OR TRUNCATE ON public.public_speaker_names FOR EACH STATEMENT EXECUTE FUNCTION public.touch_public_content_version();

--
-- Name: topics touch_public_content_version; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER touch_public_content_version AFTER INSERT OR DELETE OR UPDATE OR TRUNCATE ON public.topics FOR EACH STATEMENT EXECUTE FUNCTION public.touch_public_content_version();

--
-- Name: transcript_segments touch_public_content_version; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER touch_public_content_version AFTER INSERT OR DELETE OR UPDATE OR TRUNCATE ON public.transcript_segments FOR EACH STATEMENT EXECUTE FUNCTION public.touch_public_content_version();

--
-- Name: votes touch_public_content_version; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER touch_public_content_version AFTER INSERT OR DELETE OR UPDATE OR TRUNCATE ON public.votes FOR EACH STATEMENT EXECUTE FUNCTION public.touch_public_content_version();

--
-- Name: agenda_items trg_agenda_item_slug; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_agenda_item_slug BEFORE INSERT ON public.agenda_items FOR EACH ROW EXECUTE FUNCTION public.trigger_agenda_item_slug();

--
-- Name: bylaws trg_bylaw_slug; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_bylaw_slug BEFORE INSERT ON public.bylaws FOR EACH ROW EXECUTE FUNCTION public.trigger_bylaw_slug();

--
-- Name: elections trg_election_slug; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_election_slug BEFORE INSERT ON public.elections FOR EACH ROW EXECUTE FUNCTION public.trigger_election_slug();

--
-- Name: matters trg_matter_slug; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_matter_slug BEFORE INSERT ON public.matters FOR EACH ROW EXECUTE FUNCTION public.trigger_matter_slug();

--
-- Name: meetings trg_meeting_slug; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_meeting_slug BEFORE INSERT ON public.meetings FOR EACH ROW EXECUTE FUNCTION public.trigger_meeting_slug();

--
-- Name: motions trg_motion_slug; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_motion_slug BEFORE INSERT ON public.motions FOR EACH ROW EXECUTE FUNCTION public.trigger_motion_slug();

--
-- Name: people trg_person_slug; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_person_slug BEFORE INSERT ON public.people FOR EACH ROW EXECUTE FUNCTION public.trigger_person_slug();

--
-- Name: agenda_item_topics agenda_item_topics_agenda_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agenda_item_topics
    ADD CONSTRAINT agenda_item_topics_agenda_item_id_fkey FOREIGN KEY (agenda_item_id) REFERENCES public.agenda_items(id) ON DELETE CASCADE;

--
-- Name: agenda_item_topics agenda_item_topics_topic_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agenda_item_topics
    ADD CONSTRAINT agenda_item_topics_topic_id_fkey FOREIGN KEY (topic_id) REFERENCES public.topics(id) ON DELETE CASCADE;

--
-- Name: agenda_items agenda_items_matter_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agenda_items
    ADD CONSTRAINT agenda_items_matter_id_fkey FOREIGN KEY (matter_id) REFERENCES public.matters(id) ON DELETE SET NULL;

--
-- Name: agenda_items agenda_items_meeting_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agenda_items
    ADD CONSTRAINT agenda_items_meeting_id_fkey FOREIGN KEY (meeting_id) REFERENCES public.meetings(id) ON DELETE CASCADE;

--
-- Name: agenda_items agenda_items_parent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agenda_items
    ADD CONSTRAINT agenda_items_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES public.agenda_items(id) ON DELETE CASCADE;

--
-- Name: ai_usage ai_usage_pipeline_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_usage
    ADD CONSTRAINT ai_usage_pipeline_job_id_fkey FOREIGN KEY (pipeline_job_id) REFERENCES public.pipeline_jobs(id) ON DELETE SET NULL;

--
-- Name: api_keys api_keys_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_keys
    ADD CONSTRAINT api_keys_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

--
-- Name: attendance attendance_meeting_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attendance
    ADD CONSTRAINT attendance_meeting_id_fkey FOREIGN KEY (meeting_id) REFERENCES public.meetings(id) ON DELETE CASCADE;

--
-- Name: attendance attendance_person_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attendance
    ADD CONSTRAINT attendance_person_id_fkey FOREIGN KEY (person_id) REFERENCES public.people(id) ON DELETE CASCADE;

--
-- Name: bylaw_chunks bylaw_chunks_bylaw_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bylaw_chunks
    ADD CONSTRAINT bylaw_chunks_bylaw_id_fkey FOREIGN KEY (bylaw_id) REFERENCES public.bylaws(id) ON DELETE CASCADE;

--
-- Name: bylaws bylaws_municipality_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bylaws
    ADD CONSTRAINT bylaws_municipality_id_fkey FOREIGN KEY (municipality_id) REFERENCES public.municipalities(id);

--
-- Name: calendar_sync_state calendar_sync_state_municipality_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.calendar_sync_state
    ADD CONSTRAINT calendar_sync_state_municipality_id_fkey FOREIGN KEY (municipality_id) REFERENCES public.municipalities(id);

--
-- Name: candidacies candidacies_election_office_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.candidacies
    ADD CONSTRAINT candidacies_election_office_id_fkey FOREIGN KEY (election_office_id) REFERENCES public.election_offices(id) ON DELETE CASCADE;

--
-- Name: candidacies candidacies_person_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.candidacies
    ADD CONSTRAINT candidacies_person_id_fkey FOREIGN KEY (person_id) REFERENCES public.people(id) ON DELETE CASCADE;

--
-- Name: channel_posts channel_posts_meeting_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channel_posts
    ADD CONSTRAINT channel_posts_meeting_id_fkey FOREIGN KEY (meeting_id) REFERENCES public.meetings(id) ON DELETE CASCADE;

--
-- Name: contact_messages contact_messages_handled_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contact_messages
    ADD CONSTRAINT contact_messages_handled_by_fkey FOREIGN KEY (handled_by) REFERENCES auth.users(id) ON DELETE SET NULL;

--
-- Name: council_terms council_terms_election_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.council_terms
    ADD CONSTRAINT council_terms_election_id_fkey FOREIGN KEY (election_id) REFERENCES public.elections(id) ON DELETE SET NULL;

--
-- Name: council_terms council_terms_municipality_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.council_terms
    ADD CONSTRAINT council_terms_municipality_id_fkey FOREIGN KEY (municipality_id) REFERENCES public.municipalities(id) ON DELETE CASCADE;

--
-- Name: councillor_highlights councillor_highlights_person_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.councillor_highlights
    ADD CONSTRAINT councillor_highlights_person_id_fkey FOREIGN KEY (person_id) REFERENCES public.people(id) ON DELETE CASCADE;

--
-- Name: councillor_stances councillor_stances_person_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.councillor_stances
    ADD CONSTRAINT councillor_stances_person_id_fkey FOREIGN KEY (person_id) REFERENCES public.people(id) ON DELETE CASCADE;

--
-- Name: data_reports data_reports_duplicate_of_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.data_reports
    ADD CONSTRAINT data_reports_duplicate_of_fkey FOREIGN KEY (duplicate_of) REFERENCES public.data_reports(id) ON DELETE SET NULL;

--
-- Name: data_reports data_reports_resolved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.data_reports
    ADD CONSTRAINT data_reports_resolved_by_fkey FOREIGN KEY (resolved_by) REFERENCES auth.users(id) ON DELETE SET NULL;

--
-- Name: data_reports data_reports_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.data_reports
    ADD CONSTRAINT data_reports_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE SET NULL;

--
-- Name: document_images document_images_document_section_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_images
    ADD CONSTRAINT document_images_document_section_id_fkey FOREIGN KEY (document_section_id) REFERENCES public.document_sections(id) ON DELETE SET NULL;

--
-- Name: document_images document_images_extracted_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_images
    ADD CONSTRAINT document_images_extracted_document_id_fkey FOREIGN KEY (extracted_document_id) REFERENCES public.extracted_documents(id) ON DELETE CASCADE;

--
-- Name: document_images document_images_municipality_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_images
    ADD CONSTRAINT document_images_municipality_id_fkey FOREIGN KEY (municipality_id) REFERENCES public.municipalities(id);

--
-- Name: document_sections document_sections_agenda_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_sections
    ADD CONSTRAINT document_sections_agenda_item_id_fkey FOREIGN KEY (agenda_item_id) REFERENCES public.agenda_items(id) ON DELETE SET NULL;

--
-- Name: document_sections document_sections_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_sections
    ADD CONSTRAINT document_sections_document_id_fkey FOREIGN KEY (document_id) REFERENCES public.documents(id) ON DELETE CASCADE;

--
-- Name: document_sections document_sections_extracted_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_sections
    ADD CONSTRAINT document_sections_extracted_document_id_fkey FOREIGN KEY (extracted_document_id) REFERENCES public.extracted_documents(id) ON DELETE CASCADE;

--
-- Name: document_sections document_sections_municipality_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_sections
    ADD CONSTRAINT document_sections_municipality_id_fkey FOREIGN KEY (municipality_id) REFERENCES public.municipalities(id);

--
-- Name: documents documents_meeting_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.documents
    ADD CONSTRAINT documents_meeting_id_fkey FOREIGN KEY (meeting_id) REFERENCES public.meetings(id) ON DELETE CASCADE;

--
-- Name: documents documents_municipality_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.documents
    ADD CONSTRAINT documents_municipality_id_fkey FOREIGN KEY (municipality_id) REFERENCES public.municipalities(id);

--
-- Name: election_offices election_offices_election_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.election_offices
    ADD CONSTRAINT election_offices_election_id_fkey FOREIGN KEY (election_id) REFERENCES public.elections(id) ON DELETE CASCADE;

--
-- Name: email_enqueue_receipts email_enqueue_receipts_meeting_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_enqueue_receipts
    ADD CONSTRAINT email_enqueue_receipts_meeting_id_fkey FOREIGN KEY (meeting_id) REFERENCES public.meetings(id) ON DELETE CASCADE;

--
-- Name: email_events email_events_message_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_events
    ADD CONSTRAINT email_events_message_id_fkey FOREIGN KEY (message_id) REFERENCES public.email_messages(id) ON DELETE CASCADE;

--
-- Name: email_messages email_messages_meeting_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_messages
    ADD CONSTRAINT email_messages_meeting_id_fkey FOREIGN KEY (meeting_id) REFERENCES public.meetings(id) ON DELETE SET NULL;

--
-- Name: email_messages email_messages_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_messages
    ADD CONSTRAINT email_messages_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE SET NULL;

--
-- Name: email_suppressions email_suppressions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_suppressions
    ADD CONSTRAINT email_suppressions_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE SET NULL;

--
-- Name: extracted_documents extracted_documents_agenda_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.extracted_documents
    ADD CONSTRAINT extracted_documents_agenda_item_id_fkey FOREIGN KEY (agenda_item_id) REFERENCES public.agenda_items(id) ON DELETE SET NULL;

--
-- Name: extracted_documents extracted_documents_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.extracted_documents
    ADD CONSTRAINT extracted_documents_document_id_fkey FOREIGN KEY (document_id) REFERENCES public.documents(id) ON DELETE CASCADE;

--
-- Name: extracted_documents extracted_documents_municipality_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.extracted_documents
    ADD CONSTRAINT extracted_documents_municipality_id_fkey FOREIGN KEY (municipality_id) REFERENCES public.municipalities(id);

--
-- Name: key_statements key_statements_agenda_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.key_statements
    ADD CONSTRAINT key_statements_agenda_item_id_fkey FOREIGN KEY (agenda_item_id) REFERENCES public.agenda_items(id) ON DELETE SET NULL;

--
-- Name: key_statements key_statements_meeting_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.key_statements
    ADD CONSTRAINT key_statements_meeting_id_fkey FOREIGN KEY (meeting_id) REFERENCES public.meetings(id) ON DELETE CASCADE;

--
-- Name: key_statements key_statements_municipality_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.key_statements
    ADD CONSTRAINT key_statements_municipality_id_fkey FOREIGN KEY (municipality_id) REFERENCES public.municipalities(id);

--
-- Name: key_statements key_statements_person_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.key_statements
    ADD CONSTRAINT key_statements_person_id_fkey FOREIGN KEY (person_id) REFERENCES public.people(id) ON DELETE SET NULL;

--
-- Name: key_votes key_votes_motion_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.key_votes
    ADD CONSTRAINT key_votes_motion_id_fkey FOREIGN KEY (motion_id) REFERENCES public.motions(id) ON DELETE CASCADE;

--
-- Name: key_votes key_votes_person_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.key_votes
    ADD CONSTRAINT key_votes_person_id_fkey FOREIGN KEY (person_id) REFERENCES public.people(id) ON DELETE CASCADE;

--
-- Name: matter_evidence matter_evidence_agenda_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.matter_evidence
    ADD CONSTRAINT matter_evidence_agenda_item_id_fkey FOREIGN KEY (agenda_item_id) REFERENCES public.agenda_items(id) ON DELETE CASCADE;

--
-- Name: matter_evidence matter_evidence_document_section_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.matter_evidence
    ADD CONSTRAINT matter_evidence_document_section_id_fkey FOREIGN KEY (document_section_id) REFERENCES public.document_sections(id) ON DELETE CASCADE;

--
-- Name: matter_evidence matter_evidence_matter_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.matter_evidence
    ADD CONSTRAINT matter_evidence_matter_id_fkey FOREIGN KEY (matter_id) REFERENCES public.matters(id) ON DELETE CASCADE;

--
-- Name: matter_evidence matter_evidence_reviewed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.matter_evidence
    ADD CONSTRAINT matter_evidence_reviewed_by_fkey FOREIGN KEY (reviewed_by) REFERENCES auth.users(id) ON DELETE SET NULL;

--
-- Name: matter_links matter_links_agenda_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.matter_links
    ADD CONSTRAINT matter_links_agenda_item_id_fkey FOREIGN KEY (agenda_item_id) REFERENCES public.agenda_items(id) ON DELETE CASCADE;

--
-- Name: matter_links matter_links_matter_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.matter_links
    ADD CONSTRAINT matter_links_matter_id_fkey FOREIGN KEY (matter_id) REFERENCES public.matters(id) ON DELETE CASCADE;

--
-- Name: matter_links matter_links_related_matter_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.matter_links
    ADD CONSTRAINT matter_links_related_matter_id_fkey FOREIGN KEY (related_matter_id) REFERENCES public.matters(id) ON DELETE CASCADE;

--
-- Name: matter_links matter_links_reviewed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.matter_links
    ADD CONSTRAINT matter_links_reviewed_by_fkey FOREIGN KEY (reviewed_by) REFERENCES auth.users(id) ON DELETE SET NULL;

--
-- Name: matter_report_mentions matter_report_mentions_matter_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.matter_report_mentions
    ADD CONSTRAINT matter_report_mentions_matter_id_fkey FOREIGN KEY (matter_id) REFERENCES public.matters(id) ON DELETE CASCADE;

--
-- Name: matter_report_mentions matter_report_mentions_report_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.matter_report_mentions
    ADD CONSTRAINT matter_report_mentions_report_id_fkey FOREIGN KEY (report_id) REFERENCES public.public_reports(id) ON DELETE CASCADE;

--
-- Name: matter_report_mentions matter_report_mentions_reviewed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.matter_report_mentions
    ADD CONSTRAINT matter_report_mentions_reviewed_by_fkey FOREIGN KEY (reviewed_by) REFERENCES auth.users(id) ON DELETE SET NULL;

--
-- Name: matters matters_bylaw_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.matters
    ADD CONSTRAINT matters_bylaw_id_fkey FOREIGN KEY (bylaw_id) REFERENCES public.bylaws(id) ON DELETE SET NULL;

--
-- Name: matters matters_merged_into_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.matters
    ADD CONSTRAINT matters_merged_into_fkey FOREIGN KEY (merged_into) REFERENCES public.matters(id) ON DELETE SET NULL;

--
-- Name: matters matters_municipality_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.matters
    ADD CONSTRAINT matters_municipality_id_fkey FOREIGN KEY (municipality_id) REFERENCES public.municipalities(id);

--
-- Name: meeting_events meeting_events_meeting_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meeting_events
    ADD CONSTRAINT meeting_events_meeting_id_fkey FOREIGN KEY (meeting_id) REFERENCES public.meetings(id) ON DELETE CASCADE;

--
-- Name: meeting_events meeting_events_person_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meeting_events
    ADD CONSTRAINT meeting_events_person_id_fkey FOREIGN KEY (person_id) REFERENCES public.people(id) ON DELETE CASCADE;

--
-- Name: meeting_slug_history meeting_slug_history_meeting_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meeting_slug_history
    ADD CONSTRAINT meeting_slug_history_meeting_id_fkey FOREIGN KEY (meeting_id) REFERENCES public.meetings(id) ON DELETE CASCADE;

--
-- Name: meeting_slug_history meeting_slug_history_municipality_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meeting_slug_history
    ADD CONSTRAINT meeting_slug_history_municipality_id_fkey FOREIGN KEY (municipality_id) REFERENCES public.municipalities(id);

--
-- Name: meeting_speaker_aliases meeting_speaker_aliases_meeting_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meeting_speaker_aliases
    ADD CONSTRAINT meeting_speaker_aliases_meeting_id_fkey FOREIGN KEY (meeting_id) REFERENCES public.meetings(id) ON DELETE CASCADE;

--
-- Name: meeting_speaker_aliases meeting_speaker_aliases_person_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meeting_speaker_aliases
    ADD CONSTRAINT meeting_speaker_aliases_person_id_fkey FOREIGN KEY (person_id) REFERENCES public.people(id) ON DELETE CASCADE;

--
-- Name: meetings meetings_calendar_source_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meetings
    ADD CONSTRAINT meetings_calendar_source_id_fkey FOREIGN KEY (calendar_source_id) REFERENCES public.source_meetings(id) ON DELETE SET NULL;

--
-- Name: meetings meetings_chair_person_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meetings
    ADD CONSTRAINT meetings_chair_person_id_fkey FOREIGN KEY (chair_person_id) REFERENCES public.people(id) ON DELETE SET NULL;

--
-- Name: meetings meetings_municipality_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meetings
    ADD CONSTRAINT meetings_municipality_id_fkey FOREIGN KEY (municipality_id) REFERENCES public.municipalities(id);

--
-- Name: meetings meetings_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meetings
    ADD CONSTRAINT meetings_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE SET NULL;

--
-- Name: memberships memberships_council_term_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memberships
    ADD CONSTRAINT memberships_council_term_id_fkey FOREIGN KEY (council_term_id) REFERENCES public.council_terms(id) ON DELETE SET NULL;

--
-- Name: memberships memberships_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memberships
    ADD CONSTRAINT memberships_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

--
-- Name: memberships memberships_person_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memberships
    ADD CONSTRAINT memberships_person_id_fkey FOREIGN KEY (person_id) REFERENCES public.people(id) ON DELETE CASCADE;

--
-- Name: motions motions_agenda_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.motions
    ADD CONSTRAINT motions_agenda_item_id_fkey FOREIGN KEY (agenda_item_id) REFERENCES public.agenda_items(id) ON DELETE CASCADE;

--
-- Name: motions motions_meeting_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.motions
    ADD CONSTRAINT motions_meeting_id_fkey FOREIGN KEY (meeting_id) REFERENCES public.meetings(id) ON DELETE CASCADE;

--
-- Name: motions motions_mover_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.motions
    ADD CONSTRAINT motions_mover_id_fkey FOREIGN KEY (mover_id) REFERENCES public.people(id) ON DELETE SET NULL;

--
-- Name: motions motions_seconder_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.motions
    ADD CONSTRAINT motions_seconder_id_fkey FOREIGN KEY (seconder_id) REFERENCES public.people(id) ON DELETE SET NULL;

--
-- Name: organizations organizations_municipality_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organizations
    ADD CONSTRAINT organizations_municipality_id_fkey FOREIGN KEY (municipality_id) REFERENCES public.municipalities(id);

--
-- Name: page_reviews page_reviews_reviewed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.page_reviews
    ADD CONSTRAINT page_reviews_reviewed_by_fkey FOREIGN KEY (reviewed_by) REFERENCES auth.users(id) ON DELETE SET NULL;

--
-- Name: pipeline_jobs pipeline_jobs_municipality_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pipeline_jobs
    ADD CONSTRAINT pipeline_jobs_municipality_id_fkey FOREIGN KEY (municipality_id) REFERENCES public.municipalities(id) ON DELETE CASCADE;

--
-- Name: pipeline_run_events pipeline_run_events_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pipeline_run_events
    ADD CONSTRAINT pipeline_run_events_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.pipeline_jobs(id) ON DELETE CASCADE;

--
-- Name: property_links property_links_agenda_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.property_links
    ADD CONSTRAINT property_links_agenda_item_id_fkey FOREIGN KEY (agenda_item_id) REFERENCES public.agenda_items(id) ON DELETE CASCADE;

--
-- Name: property_links property_links_matter_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.property_links
    ADD CONSTRAINT property_links_matter_id_fkey FOREIGN KEY (matter_id) REFERENCES public.matters(id) ON DELETE CASCADE;

--
-- Name: property_links property_links_property_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.property_links
    ADD CONSTRAINT property_links_property_id_fkey FOREIGN KEY (property_id) REFERENCES public.properties(id) ON DELETE CASCADE;

--
-- Name: public_report_pages public_report_pages_report_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.public_report_pages
    ADD CONSTRAINT public_report_pages_report_id_fkey FOREIGN KEY (report_id) REFERENCES public.public_reports(id) ON DELETE CASCADE;

--
-- Name: public_reports public_reports_municipality_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.public_reports
    ADD CONSTRAINT public_reports_municipality_id_fkey FOREIGN KEY (municipality_id) REFERENCES public.municipalities(id) ON DELETE CASCADE;

--
-- Name: public_speaker_names public_speaker_names_agenda_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.public_speaker_names
    ADD CONSTRAINT public_speaker_names_agenda_item_id_fkey FOREIGN KEY (agenda_item_id) REFERENCES public.agenda_items(id) ON DELETE CASCADE;

--
-- Name: public_speaker_names public_speaker_names_meeting_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.public_speaker_names
    ADD CONSTRAINT public_speaker_names_meeting_id_fkey FOREIGN KEY (meeting_id) REFERENCES public.meetings(id) ON DELETE CASCADE;

--
-- Name: rag_feedback rag_feedback_trace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rag_feedback
    ADD CONSTRAINT rag_feedback_trace_id_fkey FOREIGN KEY (trace_id) REFERENCES public.rag_traces(id) ON DELETE CASCADE;

--
-- Name: rag_feedback rag_feedback_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rag_feedback
    ADD CONSTRAINT rag_feedback_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id);

--
-- Name: rag_traces rag_traces_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rag_traces
    ADD CONSTRAINT rag_traces_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id);

--
-- Name: review_examples review_examples_rated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.review_examples
    ADD CONSTRAINT review_examples_rated_by_fkey FOREIGN KEY (rated_by) REFERENCES auth.users(id) ON DELETE SET NULL;

--
-- Name: review_guidance review_guidance_decided_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.review_guidance
    ADD CONSTRAINT review_guidance_decided_by_fkey FOREIGN KEY (decided_by) REFERENCES auth.users(id) ON DELETE SET NULL;

--
-- Name: source_meetings source_meetings_ingested_meeting_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_meetings
    ADD CONSTRAINT source_meetings_ingested_meeting_id_fkey FOREIGN KEY (ingested_meeting_id) REFERENCES public.meetings(id) ON DELETE SET NULL;

--
-- Name: source_meetings source_meetings_municipality_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_meetings
    ADD CONSTRAINT source_meetings_municipality_id_fkey FOREIGN KEY (municipality_id) REFERENCES public.municipalities(id) ON DELETE CASCADE;

--
-- Name: staff_actions staff_actions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_actions
    ADD CONSTRAINT staff_actions_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE SET NULL;

--
-- Name: subscriptions subscriptions_matter_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscriptions
    ADD CONSTRAINT subscriptions_matter_id_fkey FOREIGN KEY (matter_id) REFERENCES public.matters(id) ON DELETE CASCADE;

--
-- Name: subscriptions subscriptions_person_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscriptions
    ADD CONSTRAINT subscriptions_person_id_fkey FOREIGN KEY (person_id) REFERENCES public.people(id) ON DELETE CASCADE;

--
-- Name: subscriptions subscriptions_topic_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscriptions
    ADD CONSTRAINT subscriptions_topic_id_fkey FOREIGN KEY (topic_id) REFERENCES public.topics(id) ON DELETE CASCADE;

--
-- Name: subscriptions subscriptions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscriptions
    ADD CONSTRAINT subscriptions_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

--
-- Name: transcript_identity_evidence transcript_identity_evidence_meeting_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transcript_identity_evidence
    ADD CONSTRAINT transcript_identity_evidence_meeting_id_fkey FOREIGN KEY (meeting_id) REFERENCES public.meetings(id) ON DELETE RESTRICT;

--
-- Name: transcript_identity_evidence transcript_identity_evidence_person_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transcript_identity_evidence
    ADD CONSTRAINT transcript_identity_evidence_person_id_fkey FOREIGN KEY (person_id) REFERENCES public.people(id) ON DELETE RESTRICT;

--
-- Name: transcript_identity_evidence transcript_identity_evidence_segment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transcript_identity_evidence
    ADD CONSTRAINT transcript_identity_evidence_segment_id_fkey FOREIGN KEY (segment_id) REFERENCES public.transcript_segments(id) ON DELETE RESTRICT;

--
-- Name: transcript_segments transcript_segments_agenda_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transcript_segments
    ADD CONSTRAINT transcript_segments_agenda_item_id_fkey FOREIGN KEY (agenda_item_id) REFERENCES public.agenda_items(id) ON DELETE SET NULL;

--
-- Name: transcript_segments transcript_segments_meeting_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transcript_segments
    ADD CONSTRAINT transcript_segments_meeting_id_fkey FOREIGN KEY (meeting_id) REFERENCES public.meetings(id) ON DELETE CASCADE;

--
-- Name: transcript_segments transcript_segments_motion_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transcript_segments
    ADD CONSTRAINT transcript_segments_motion_id_fkey FOREIGN KEY (motion_id) REFERENCES public.motions(id) ON DELETE SET NULL;

--
-- Name: transcript_segments transcript_segments_person_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transcript_segments
    ADD CONSTRAINT transcript_segments_person_id_fkey FOREIGN KEY (person_id) REFERENCES public.people(id) ON DELETE SET NULL;

--
-- Name: user_profiles user_profiles_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_profiles
    ADD CONSTRAINT user_profiles_id_fkey FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE;

--
-- Name: user_roles user_roles_granted_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_roles
    ADD CONSTRAINT user_roles_granted_by_fkey FOREIGN KEY (granted_by) REFERENCES auth.users(id) ON DELETE SET NULL;

--
-- Name: user_roles user_roles_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_roles
    ADD CONSTRAINT user_roles_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

--
-- Name: voice_exemplars voice_exemplars_meeting_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.voice_exemplars
    ADD CONSTRAINT voice_exemplars_meeting_id_fkey FOREIGN KEY (meeting_id) REFERENCES public.meetings(id) ON DELETE CASCADE;

--
-- Name: voice_exemplars voice_exemplars_person_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.voice_exemplars
    ADD CONSTRAINT voice_exemplars_person_id_fkey FOREIGN KEY (person_id) REFERENCES public.people(id) ON DELETE CASCADE;

--
-- Name: voice_fingerprints voice_fingerprints_person_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.voice_fingerprints
    ADD CONSTRAINT voice_fingerprints_person_id_fkey FOREIGN KEY (person_id) REFERENCES public.people(id) ON DELETE CASCADE;

--
-- Name: voice_fingerprints voice_fingerprints_source_meeting_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.voice_fingerprints
    ADD CONSTRAINT voice_fingerprints_source_meeting_id_fkey FOREIGN KEY (source_meeting_id) REFERENCES public.meetings(id) ON DELETE SET NULL;

--
-- Name: votes votes_motion_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.votes
    ADD CONSTRAINT votes_motion_id_fkey FOREIGN KEY (motion_id) REFERENCES public.motions(id) ON DELETE CASCADE;

--
-- Name: votes votes_person_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.votes
    ADD CONSTRAINT votes_person_id_fkey FOREIGN KEY (person_id) REFERENCES public.people(id) ON DELETE CASCADE;

--
-- Name: document_images Allow public read access; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Allow public read access" ON public.document_images FOR SELECT USING (true);

--
-- Name: document_sections Allow public read access; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Allow public read access" ON public.document_sections FOR SELECT USING (true);

--
-- Name: extracted_documents Allow public read access; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Allow public read access" ON public.extracted_documents FOR SELECT USING (true);

--
-- Name: ocd_divisions Allow public read access; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Allow public read access" ON public.ocd_divisions FOR SELECT USING (true);

--
-- Name: documents Allow public read access on documents; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Allow public read access on documents" ON public.documents FOR SELECT USING (true);

--
-- Name: councillor_highlights Allow public read access to councillor highlights; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Allow public read access to councillor highlights" ON public.councillor_highlights FOR SELECT TO authenticated, anon USING (true);

--
-- Name: councillor_stances Allow public read access to councillor stances; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Allow public read access to councillor stances" ON public.councillor_stances FOR SELECT TO authenticated, anon USING (true);

--
-- Name: agenda_item_topics Allow public read-only access on agenda_item_topics; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Allow public read-only access on agenda_item_topics" ON public.agenda_item_topics FOR SELECT USING (true);

--
-- Name: agenda_items Allow public read-only access on agenda_items; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Allow public read-only access on agenda_items" ON public.agenda_items FOR SELECT USING (true);

--
-- Name: attendance Allow public read-only access on attendance; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Allow public read-only access on attendance" ON public.attendance FOR SELECT USING (true);

--
-- Name: bylaw_chunks Allow public read-only access on bylaw_chunks; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Allow public read-only access on bylaw_chunks" ON public.bylaw_chunks FOR SELECT USING (true);

--
-- Name: bylaws Allow public read-only access on bylaws; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Allow public read-only access on bylaws" ON public.bylaws FOR SELECT USING (true);

--
-- Name: candidacies Allow public read-only access on candidacies; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Allow public read-only access on candidacies" ON public.candidacies FOR SELECT USING (true);

--
-- Name: council_terms Allow public read-only access on council_terms; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Allow public read-only access on council_terms" ON public.council_terms FOR SELECT USING (true);

--
-- Name: election_offices Allow public read-only access on election_offices; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Allow public read-only access on election_offices" ON public.election_offices FOR SELECT USING (true);

--
-- Name: elections Allow public read-only access on elections; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Allow public read-only access on elections" ON public.elections FOR SELECT USING (true);

--
-- Name: key_statements Allow public read-only access on key_statements; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Allow public read-only access on key_statements" ON public.key_statements FOR SELECT USING (true);

--
-- Name: matter_evidence Allow public read-only access on matter_evidence; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Allow public read-only access on matter_evidence" ON public.matter_evidence FOR SELECT USING ((NOT hidden));

--
-- Name: matters Allow public read-only access on matters; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Allow public read-only access on matters" ON public.matters FOR SELECT USING (true);

--
-- Name: meeting_events Allow public read-only access on meeting_events; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Allow public read-only access on meeting_events" ON public.meeting_events FOR SELECT USING (true);

--
-- Name: meeting_speaker_aliases Allow public read-only access on meeting_speaker_aliases; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Allow public read-only access on meeting_speaker_aliases" ON public.meeting_speaker_aliases FOR SELECT USING (true);

--
-- Name: meetings Allow public read-only access on meetings; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Allow public read-only access on meetings" ON public.meetings FOR SELECT USING (true);

--
-- Name: memberships Allow public read-only access on memberships; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Allow public read-only access on memberships" ON public.memberships FOR SELECT USING (true);

--
-- Name: motions Allow public read-only access on motions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Allow public read-only access on motions" ON public.motions FOR SELECT USING (true);

--
-- Name: organizations Allow public read-only access on organizations; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Allow public read-only access on organizations" ON public.organizations FOR SELECT USING (true);

--
-- Name: people Allow public read-only access on people; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Allow public read-only access on people" ON public.people FOR SELECT USING (true);

--
-- Name: topics Allow public read-only access on topics; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Allow public read-only access on topics" ON public.topics FOR SELECT USING (true);

--
-- Name: transcript_segments Allow public read-only access on transcript_segments; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Allow public read-only access on transcript_segments" ON public.transcript_segments FOR SELECT USING (true);

--
-- Name: votes Allow public read-only access on votes; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Allow public read-only access on votes" ON public.votes FOR SELECT USING (true);

--
-- Name: matter_evidence Enable service role access on matter_evidence; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Enable service role access on matter_evidence" ON public.matter_evidence USING ((auth.role() = 'service_role'::text)) WITH CHECK ((auth.role() = 'service_role'::text));

--
-- Name: pipeline_jobs Enable service role access on pipeline_jobs; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Enable service role access on pipeline_jobs" ON public.pipeline_jobs USING ((auth.role() = 'service_role'::text)) WITH CHECK ((auth.role() = 'service_role'::text));

--
-- Name: pipeline_run_events Enable service role access on pipeline_run_events; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Enable service role access on pipeline_run_events" ON public.pipeline_run_events USING ((auth.role() = 'service_role'::text)) WITH CHECK ((auth.role() = 'service_role'::text));

--
-- Name: source_meetings Enable service role access on source_meetings; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Enable service role access on source_meetings" ON public.source_meetings USING ((auth.role() = 'service_role'::text)) WITH CHECK ((auth.role() = 'service_role'::text));

--
-- Name: voice_fingerprints Enable service role access on voice_fingerprints; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Enable service role access on voice_fingerprints" ON public.voice_fingerprints USING ((auth.role() = 'service_role'::text)) WITH CHECK ((auth.role() = 'service_role'::text));

--
-- Name: bylaw_chunks Enable write access for service role on bylaw_chunks; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Enable write access for service role on bylaw_chunks" ON public.bylaw_chunks USING ((auth.role() = 'service_role'::text));

--
-- Name: bylaws Enable write access for service role on bylaws; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Enable write access for service role on bylaws" ON public.bylaws USING ((auth.role() = 'service_role'::text));

--
-- Name: documents Enable write for service role on documents; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Enable write for service role on documents" ON public.documents USING ((auth.role() = 'service_role'::text));

--
-- Name: key_statements Enable write for service role on key_statements; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Enable write for service role on key_statements" ON public.key_statements USING ((auth.role() = 'service_role'::text));

--
-- Name: key_votes Public read access for key_votes; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Public read access for key_votes" ON public.key_votes FOR SELECT USING (true);

--
-- Name: search_results_cache Service role can insert cached results; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Service role can insert cached results" ON public.search_results_cache FOR INSERT TO service_role WITH CHECK (true);

--
-- Name: subscriptions Service role can manage subscriptions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Service role can manage subscriptions" ON public.subscriptions USING ((auth.role() = 'service_role'::text)) WITH CHECK ((auth.role() = 'service_role'::text));

--
-- Name: user_profiles Service role can manage user profiles; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Service role can manage user profiles" ON public.user_profiles USING ((auth.role() = 'service_role'::text)) WITH CHECK ((auth.role() = 'service_role'::text));

--
-- Name: api_keys Users can create own keys; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can create own keys" ON public.api_keys FOR INSERT WITH CHECK ((auth.uid() = user_id));

--
-- Name: subscriptions Users can delete their own subscriptions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can delete their own subscriptions" ON public.subscriptions FOR DELETE TO authenticated USING ((auth.uid() = user_id));

--
-- Name: user_profiles Users can insert their own profile; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can insert their own profile" ON public.user_profiles FOR INSERT TO authenticated WITH CHECK ((auth.uid() = id));

--
-- Name: subscriptions Users can insert their own subscriptions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can insert their own subscriptions" ON public.subscriptions FOR INSERT TO authenticated WITH CHECK ((auth.uid() = user_id));

--
-- Name: user_profiles Users can read their own profile; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can read their own profile" ON public.user_profiles FOR SELECT TO authenticated USING ((auth.uid() = id));

--
-- Name: subscriptions Users can read their own subscriptions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can read their own subscriptions" ON public.subscriptions FOR SELECT TO authenticated USING ((auth.uid() = user_id));

--
-- Name: api_keys Users can update own keys; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can update own keys" ON public.api_keys FOR UPDATE USING ((auth.uid() = user_id));

--
-- Name: user_profiles Users can update their own profile; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can update their own profile" ON public.user_profiles FOR UPDATE TO authenticated USING ((auth.uid() = id)) WITH CHECK ((auth.uid() = id));

--
-- Name: subscriptions Users can update their own subscriptions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can update their own subscriptions" ON public.subscriptions FOR UPDATE TO authenticated USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));

--
-- Name: api_keys Users can view own keys; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view own keys" ON public.api_keys FOR SELECT USING ((auth.uid() = user_id));

--
-- Name: agenda_item_topics; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.agenda_item_topics ENABLE ROW LEVEL SECURITY;

--
-- Name: agenda_items; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.agenda_items ENABLE ROW LEVEL SECURITY;

--
-- Name: ai_usage; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ai_usage ENABLE ROW LEVEL SECURITY;

--
-- Name: ai_usage_daily; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ai_usage_daily ENABLE ROW LEVEL SECURITY;

--
-- Name: api_keys; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.api_keys ENABLE ROW LEVEL SECURITY;

--
-- Name: attendance; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.attendance ENABLE ROW LEVEL SECURITY;

--
-- Name: bylaw_chunks; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.bylaw_chunks ENABLE ROW LEVEL SECURITY;

--
-- Name: bylaws; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.bylaws ENABLE ROW LEVEL SECURITY;

--
-- Name: calendar_sync_state; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.calendar_sync_state ENABLE ROW LEVEL SECURITY;

--
-- Name: candidacies; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.candidacies ENABLE ROW LEVEL SECURITY;

--
-- Name: channel_posts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.channel_posts ENABLE ROW LEVEL SECURITY;

--
-- Name: computed_cache; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.computed_cache ENABLE ROW LEVEL SECURITY;

--
-- Name: contact_messages; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.contact_messages ENABLE ROW LEVEL SECURITY;

--
-- Name: council_terms; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.council_terms ENABLE ROW LEVEL SECURITY;

--
-- Name: councillor_highlights; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.councillor_highlights ENABLE ROW LEVEL SECURITY;

--
-- Name: councillor_stances; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.councillor_stances ENABLE ROW LEVEL SECURITY;

--
-- Name: data_reports; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.data_reports ENABLE ROW LEVEL SECURITY;

--
-- Name: document_images; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.document_images ENABLE ROW LEVEL SECURITY;

--
-- Name: document_sections; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.document_sections ENABLE ROW LEVEL SECURITY;

--
-- Name: documents; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.documents ENABLE ROW LEVEL SECURITY;

--
-- Name: election_offices; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.election_offices ENABLE ROW LEVEL SECURITY;

--
-- Name: elections; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.elections ENABLE ROW LEVEL SECURITY;

--
-- Name: email_enqueue_receipts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.email_enqueue_receipts ENABLE ROW LEVEL SECURITY;

--
-- Name: email_events; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.email_events ENABLE ROW LEVEL SECURITY;

--
-- Name: email_messages; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.email_messages ENABLE ROW LEVEL SECURITY;

--
-- Name: email_suppressions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.email_suppressions ENABLE ROW LEVEL SECURITY;

--
-- Name: extracted_documents; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.extracted_documents ENABLE ROW LEVEL SECURITY;

--
-- Name: hidden_pages; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.hidden_pages ENABLE ROW LEVEL SECURITY;

--
-- Name: key_statements; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.key_statements ENABLE ROW LEVEL SECURITY;

--
-- Name: key_votes; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.key_votes ENABLE ROW LEVEL SECURITY;

--
-- Name: matter_evidence; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.matter_evidence ENABLE ROW LEVEL SECURITY;

--
-- Name: matter_links; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.matter_links ENABLE ROW LEVEL SECURITY;

--
-- Name: matter_links matter_links public read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "matter_links public read" ON public.matter_links FOR SELECT TO authenticated, anon USING ((NOT hidden));

--
-- Name: matter_merge_proposals; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.matter_merge_proposals ENABLE ROW LEVEL SECURITY;

--
-- Name: matter_merges; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.matter_merges ENABLE ROW LEVEL SECURITY;

--
-- Name: matter_report_mentions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.matter_report_mentions ENABLE ROW LEVEL SECURITY;

--
-- Name: matter_report_mentions matter_report_mentions public read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "matter_report_mentions public read" ON public.matter_report_mentions FOR SELECT TO authenticated, anon USING ((NOT hidden));

--
-- Name: matters; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.matters ENABLE ROW LEVEL SECURITY;

--
-- Name: meeting_events; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.meeting_events ENABLE ROW LEVEL SECURITY;

--
-- Name: meeting_slug_history; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.meeting_slug_history ENABLE ROW LEVEL SECURITY;

--
-- Name: meeting_slug_history meeting_slug_history public read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "meeting_slug_history public read" ON public.meeting_slug_history FOR SELECT TO authenticated, anon USING (true);

--
-- Name: meeting_speaker_aliases; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.meeting_speaker_aliases ENABLE ROW LEVEL SECURITY;

--
-- Name: meetings; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.meetings ENABLE ROW LEVEL SECURITY;

--
-- Name: memberships; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.memberships ENABLE ROW LEVEL SECURITY;

--
-- Name: motions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.motions ENABLE ROW LEVEL SECURITY;

--
-- Name: municipalities; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.municipalities ENABLE ROW LEVEL SECURITY;

--
-- Name: municipalities municipalities_public_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY municipalities_public_read ON public.municipalities FOR SELECT TO authenticated, anon USING (true);

--
-- Name: ocd_divisions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ocd_divisions ENABLE ROW LEVEL SECURITY;

--
-- Name: organizations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.organizations ENABLE ROW LEVEL SECURITY;

--
-- Name: page_reviews; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.page_reviews ENABLE ROW LEVEL SECURITY;

--
-- Name: people; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.people ENABLE ROW LEVEL SECURITY;

--
-- Name: pipeline_jobs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.pipeline_jobs ENABLE ROW LEVEL SECURITY;

--
-- Name: pipeline_run_events; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.pipeline_run_events ENABLE ROW LEVEL SECURITY;

--
-- Name: properties; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.properties ENABLE ROW LEVEL SECURITY;

--
-- Name: properties properties public read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "properties public read" ON public.properties FOR SELECT TO authenticated, anon USING ((NOT hidden));

--
-- Name: property_links; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.property_links ENABLE ROW LEVEL SECURITY;

--
-- Name: property_links property_links public read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "property_links public read" ON public.property_links FOR SELECT TO authenticated, anon USING (((NOT hidden) AND (EXISTS ( SELECT 1
   FROM public.properties p
  WHERE ((p.id = property_links.property_id) AND (NOT p.hidden))))));

--
-- Name: public_content_version; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.public_content_version ENABLE ROW LEVEL SECURITY;

--
-- Name: public_report_pages; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.public_report_pages ENABLE ROW LEVEL SECURITY;

--
-- Name: public_report_pages public_report_pages public read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "public_report_pages public read" ON public.public_report_pages FOR SELECT TO authenticated, anon USING (true);

--
-- Name: public_reports; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.public_reports ENABLE ROW LEVEL SECURITY;

--
-- Name: public_reports public_reports public read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "public_reports public read" ON public.public_reports FOR SELECT TO authenticated, anon USING (true);

--
-- Name: public_speaker_names; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.public_speaker_names ENABLE ROW LEVEL SECURITY;

--
-- Name: rag_feedback; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.rag_feedback ENABLE ROW LEVEL SECURITY;

--
-- Name: rag_traces; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.rag_traces ENABLE ROW LEVEL SECURITY;

--
-- Name: review_examples; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.review_examples ENABLE ROW LEVEL SECURITY;

--
-- Name: review_guidance; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.review_guidance ENABLE ROW LEVEL SECURITY;

--
-- Name: search_daily_usage; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.search_daily_usage ENABLE ROW LEVEL SECURITY;

--
-- Name: search_results_cache; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.search_results_cache ENABLE ROW LEVEL SECURITY;

--
-- Name: server_metrics; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.server_metrics ENABLE ROW LEVEL SECURITY;

--
-- Name: rag_feedback service_role_all_rag_feedback; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY service_role_all_rag_feedback ON public.rag_feedback TO service_role USING (true) WITH CHECK (true);

--
-- Name: rag_traces service_role_all_rag_traces; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY service_role_all_rag_traces ON public.rag_traces TO service_role USING (true) WITH CHECK (true);

--
-- Name: source_meetings; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.source_meetings ENABLE ROW LEVEL SECURITY;

--
-- Name: staff_actions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.staff_actions ENABLE ROW LEVEL SECURITY;

--
-- Name: subscriptions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.subscriptions ENABLE ROW LEVEL SECURITY;

--
-- Name: topics; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.topics ENABLE ROW LEVEL SECURITY;

--
-- Name: transcript_identity_evidence; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.transcript_identity_evidence ENABLE ROW LEVEL SECURITY;

--
-- Name: transcript_segments; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.transcript_segments ENABLE ROW LEVEL SECURITY;

--
-- Name: user_profiles; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.user_profiles ENABLE ROW LEVEL SECURITY;

--
-- Name: user_roles; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;

--
-- Name: voice_exemplars; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.voice_exemplars ENABLE ROW LEVEL SECURITY;

--
-- Name: voice_fingerprints; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.voice_fingerprints ENABLE ROW LEVEL SECURITY;

--
-- Name: votes; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.votes ENABLE ROW LEVEL SECURITY;

--
-- Object privileges. A new Supabase database gives anon, authenticated and service_role access to every
-- object created in public (default privileges). Production's grants are narrower, so start from none
-- and apply exactly the grants below.
--

DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT CASE WHEN c.relkind = 'S' THEN 'SEQUENCE' ELSE 'TABLE' END AS kind, c.oid::regclass::text AS name
    FROM pg_class c
    WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
    UNION ALL
    SELECT 'FUNCTION', p.oid::regprocedure::text
    FROM pg_proc p
    WHERE p.pronamespace = 'public'::regnamespace AND p.prokind IN ('f', 'p')
      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
  LOOP
    EXECUTE format('REVOKE ALL ON %s %s FROM anon, authenticated, service_role', r.kind, r.name);
  END LOOP;
END $$;

--
-- Name: SCHEMA public; Type: ACL; Schema: -; Owner: -
--

GRANT USAGE ON SCHEMA public TO postgres;
GRANT USAGE ON SCHEMA public TO anon;
GRANT USAGE ON SCHEMA public TO authenticated;
GRANT USAGE ON SCHEMA public TO service_role;

--
-- Name: FUNCTION _council_attendance_js_text(value json); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public._council_attendance_js_text(value json) FROM PUBLIC;
GRANT ALL ON FUNCTION public._council_attendance_js_text(value json) TO service_role;

--
-- Name: FUNCTION _council_attendance_state(p_notes text, p_mode text, p_meeting_id bigint, p_person_id bigint, p_date date); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public._council_attendance_state(p_notes text, p_mode text, p_meeting_id bigint, p_person_id bigint, p_date date) FROM PUBLIC;
GRANT ALL ON FUNCTION public._council_attendance_state(p_notes text, p_mode text, p_meeting_id bigint, p_person_id bigint, p_date date) TO service_role;

--
-- Name: FUNCTION _council_attendance_trim(value text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public._council_attendance_trim(value text) FROM PUBLIC;
GRANT ALL ON FUNCTION public._council_attendance_trim(value text) TO service_role;

--
-- Name: FUNCTION ai_usage_summary(since timestamp with time zone); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.ai_usage_summary(since timestamp with time zone) FROM PUBLIC;
GRANT ALL ON FUNCTION public.ai_usage_summary(since timestamp with time zone) TO service_role;

--
-- Name: FUNCTION anonymize_email_messages(p_ids uuid[]); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.anonymize_email_messages(p_ids uuid[]) FROM PUBLIC;
GRANT ALL ON FUNCTION public.anonymize_email_messages(p_ids uuid[]) TO service_role;

--
-- Name: FUNCTION apply_calendar_sync(p_token uuid, p_events jsonb, p_warnings jsonb); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.apply_calendar_sync(p_token uuid, p_events jsonb, p_warnings jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.apply_calendar_sync(p_token uuid, p_events jsonb, p_warnings jsonb) TO service_role;

--
-- Name: FUNCTION apply_log_retention(p_keep_days integer, p_batch integer, p_dry_run boolean); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.apply_log_retention(p_keep_days integer, p_batch integer, p_dry_run boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION public.apply_log_retention(p_keep_days integer, p_batch integer, p_dry_run boolean) TO service_role;

--
-- Name: FUNCTION apply_privacy_retention(p_dry_run boolean); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.apply_privacy_retention(p_dry_run boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION public.apply_privacy_retention(p_dry_run boolean) TO service_role;

--
-- Name: FUNCTION apply_public_participation_summary(p_item_id integer, p_expected_item jsonb, p_expected_segments jsonb, p_after_meta jsonb); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.apply_public_participation_summary(p_item_id integer, p_expected_item jsonb, p_expected_segments jsonb, p_after_meta jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.apply_public_participation_summary(p_item_id integer, p_expected_item jsonb, p_expected_segments jsonb, p_after_meta jsonb) TO service_role;

--
-- Name: FUNCTION apply_transcript_identity_evidence(p_segment_id bigint, p_expected jsonb, p_person_id bigint, p_speaker_name text, p_validator_version text, p_validator_sha256 text, p_input_sha256 text, p_source_run jsonb, p_evidence jsonb, p_input_canonical_json text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.apply_transcript_identity_evidence(p_segment_id bigint, p_expected jsonb, p_person_id bigint, p_speaker_name text, p_validator_version text, p_validator_sha256 text, p_input_sha256 text, p_source_run jsonb, p_evidence jsonb, p_input_canonical_json text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.apply_transcript_identity_evidence(p_segment_id bigint, p_expected jsonb, p_person_id bigint, p_speaker_name text, p_validator_version text, p_validator_sha256 text, p_input_sha256 text, p_source_run jsonb, p_evidence jsonb, p_input_canonical_json text) TO service_role;

--
-- Name: FUNCTION build_meeting_digest(target_meeting_id bigint); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.build_meeting_digest(target_meeting_id bigint) FROM PUBLIC;
GRANT ALL ON FUNCTION public.build_meeting_digest(target_meeting_id bigint) TO service_role;

--
-- Name: FUNCTION bulk_classify_topics_by_category(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.bulk_classify_topics_by_category() TO anon;
GRANT ALL ON FUNCTION public.bulk_classify_topics_by_category() TO authenticated;
GRANT ALL ON FUNCTION public.bulk_classify_topics_by_category() TO service_role;

--
-- Name: FUNCTION bylaw_slug_base(bylaw_number text, title text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.bylaw_slug_base(bylaw_number text, title text) TO anon;
GRANT ALL ON FUNCTION public.bylaw_slug_base(bylaw_number text, title text) TO authenticated;
GRANT ALL ON FUNCTION public.bylaw_slug_base(bylaw_number text, title text) TO service_role;

--
-- Name: FUNCTION claim_calendar_sync(p_trigger text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.claim_calendar_sync(p_trigger text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.claim_calendar_sync(p_trigger text) TO service_role;

--
-- Name: TABLE email_messages; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.email_messages TO service_role;

--
-- Name: FUNCTION claim_email_alert(p_test_recipient text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.claim_email_alert(p_test_recipient text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.claim_email_alert(p_test_recipient text) TO service_role;

--
-- Name: TABLE pipeline_jobs; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.pipeline_jobs TO anon;
GRANT ALL ON TABLE public.pipeline_jobs TO authenticated;
GRANT ALL ON TABLE public.pipeline_jobs TO service_role;

--
-- Name: FUNCTION claim_next_pipeline_job(worker_id text, job_types text[]); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.claim_next_pipeline_job(worker_id text, job_types text[]) FROM PUBLIC;
GRANT ALL ON FUNCTION public.claim_next_pipeline_job(worker_id text, job_types text[]) TO service_role;

--
-- Name: FUNCTION council_attendance_summaries(p_municipality_id bigint, p_as_of date); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.council_attendance_summaries(p_municipality_id bigint, p_as_of date) FROM PUBLIC;
GRANT ALL ON FUNCTION public.council_attendance_summaries(p_municipality_id bigint, p_as_of date) TO service_role;

--
-- Name: FUNCTION council_term_stats(p_municipality_id bigint, p_as_of date); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.council_term_stats(p_municipality_id bigint, p_as_of date) FROM PUBLIC;
GRANT ALL ON FUNCTION public.council_term_stats(p_municipality_id bigint, p_as_of date) TO service_role;

--
-- Name: FUNCTION delete_account_data(p_user_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.delete_account_data(p_user_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.delete_account_data(p_user_id uuid) TO service_role;

--
-- Name: FUNCTION drop_own_mention(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.drop_own_mention() TO anon;
GRANT ALL ON FUNCTION public.drop_own_mention() TO authenticated;
GRANT ALL ON FUNCTION public.drop_own_mention() TO service_role;

--
-- Name: FUNCTION election_slug_base(name text, election_date date); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.election_slug_base(name text, election_date date) TO anon;
GRANT ALL ON FUNCTION public.election_slug_base(name text, election_date date) TO authenticated;
GRANT ALL ON FUNCTION public.election_slug_base(name text, election_date date) TO service_role;

--
-- Name: FUNCTION email_alert_eligible(p_message uuid, p_start_date date); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.email_alert_eligible(p_message uuid, p_start_date date) FROM PUBLIC;
GRANT ALL ON FUNCTION public.email_alert_eligible(p_message uuid, p_start_date date) TO service_role;

--
-- Name: FUNCTION email_distance_m(lat1 double precision, lng1 double precision, location jsonb); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.email_distance_m(lat1 double precision, lng1 double precision, location jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.email_distance_m(lat1 double precision, lng1 double precision, location jsonb) TO service_role;

--
-- Name: FUNCTION enqueue_meeting_emails(p_meeting bigint, p_start_date date, p_test_recipient text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.enqueue_meeting_emails(p_meeting bigint, p_start_date date, p_test_recipient text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.enqueue_meeting_emails(p_meeting bigint, p_start_date date, p_test_recipient text) TO service_role;

--
-- Name: FUNCTION fail_calendar_sync(p_token uuid, p_error text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.fail_calendar_sync(p_token uuid, p_error text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.fail_calendar_sync(p_token uuid, p_error text) TO service_role;

--
-- Name: FUNCTION find_meeting_subscribers(target_meeting_id bigint); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.find_meeting_subscribers(target_meeting_id bigint) FROM PUBLIC;
GRANT ALL ON FUNCTION public.find_meeting_subscribers(target_meeting_id bigint) TO service_role;

--
-- Name: FUNCTION finish_email_alert(p_message uuid, p_lease uuid, p_state text, p_provider_id text, p_error text, p_retry_seconds integer); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.finish_email_alert(p_message uuid, p_lease uuid, p_state text, p_provider_id text, p_error text, p_retry_seconds integer) FROM PUBLIC;
GRANT ALL ON FUNCTION public.finish_email_alert(p_message uuid, p_lease uuid, p_state text, p_provider_id text, p_error text, p_retry_seconds integer) TO service_role;

--
-- Name: FUNCTION flatten_matter_merge(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.flatten_matter_merge() TO anon;
GRANT ALL ON FUNCTION public.flatten_matter_merge() TO authenticated;
GRANT ALL ON FUNCTION public.flatten_matter_merge() TO service_role;

--
-- Name: FUNCTION freeze_email_alert(p_message uuid, p_lease uuid, p_body jsonb); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.freeze_email_alert(p_message uuid, p_lease uuid, p_body jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.freeze_email_alert(p_message uuid, p_lease uuid, p_body jsonb) TO service_role;

--
-- Name: FUNCTION generate_slug(input text, max_len integer); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.generate_slug(input text, max_len integer) TO anon;
GRANT ALL ON FUNCTION public.generate_slug(input text, max_len integer) TO authenticated;
GRANT ALL ON FUNCTION public.generate_slug(input text, max_len integer) TO service_role;

--
-- Name: FUNCTION generate_slug_capped(input text, max_len integer); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.generate_slug_capped(input text, max_len integer) TO anon;
GRANT ALL ON FUNCTION public.generate_slug_capped(input text, max_len integer) TO authenticated;
GRANT ALL ON FUNCTION public.generate_slug_capped(input text, max_len integer) TO service_role;

--
-- Name: FUNCTION get_meetings_with_stats(filter_municipality_id bigint); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.get_meetings_with_stats(filter_municipality_id bigint) FROM PUBLIC;
GRANT ALL ON FUNCTION public.get_meetings_with_stats(filter_municipality_id bigint) TO service_role;

--
-- Name: FUNCTION get_speaking_time_by_meeting(p_person_id bigint, p_start_date date, p_end_date date); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.get_speaking_time_by_meeting(p_person_id bigint, p_start_date date, p_end_date date) FROM PUBLIC;
GRANT ALL ON FUNCTION public.get_speaking_time_by_meeting(p_person_id bigint, p_start_date date, p_end_date date) TO service_role;

--
-- Name: FUNCTION get_speaking_time_by_meeting(p_person_id bigint, p_start_date date, p_end_date date, filter_municipality_id bigint); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.get_speaking_time_by_meeting(p_person_id bigint, p_start_date date, p_end_date date, filter_municipality_id bigint) FROM PUBLIC;
GRANT ALL ON FUNCTION public.get_speaking_time_by_meeting(p_person_id bigint, p_start_date date, p_end_date date, filter_municipality_id bigint) TO service_role;

--
-- Name: FUNCTION get_speaking_time_by_topic(p_person_id bigint, p_start_date date, p_end_date date); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.get_speaking_time_by_topic(p_person_id bigint, p_start_date date, p_end_date date) FROM PUBLIC;
GRANT ALL ON FUNCTION public.get_speaking_time_by_topic(p_person_id bigint, p_start_date date, p_end_date date) TO service_role;

--
-- Name: FUNCTION get_speaking_time_by_topic(p_person_id bigint, p_start_date date, p_end_date date, filter_municipality_id bigint); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.get_speaking_time_by_topic(p_person_id bigint, p_start_date date, p_end_date date, filter_municipality_id bigint) FROM PUBLIC;
GRANT ALL ON FUNCTION public.get_speaking_time_by_topic(p_person_id bigint, p_start_date date, p_end_date date, filter_municipality_id bigint) TO service_role;

--
-- Name: FUNCTION get_speaking_time_stats(p_start_date date, p_end_date date); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.get_speaking_time_stats(p_start_date date, p_end_date date) FROM PUBLIC;
GRANT ALL ON FUNCTION public.get_speaking_time_stats(p_start_date date, p_end_date date) TO service_role;

--
-- Name: FUNCTION get_speaking_time_stats(p_start_date date, p_end_date date, filter_municipality_id bigint); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.get_speaking_time_stats(p_start_date date, p_end_date date, filter_municipality_id bigint) FROM PUBLIC;
GRANT ALL ON FUNCTION public.get_speaking_time_stats(p_start_date date, p_end_date date, filter_municipality_id bigint) TO service_role;

--
-- Name: FUNCTION get_unclassified_agenda_items(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.get_unclassified_agenda_items() FROM PUBLIC;
GRANT ALL ON FUNCTION public.get_unclassified_agenda_items() TO service_role;

--
-- Name: FUNCTION hybrid_search_bylaw_chunks(query_text text, query_embedding public.halfvec, match_count integer, full_text_weight double precision, semantic_weight double precision, rrf_k double precision, filter_municipality_id bigint); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.hybrid_search_bylaw_chunks(query_text text, query_embedding public.halfvec, match_count integer, full_text_weight double precision, semantic_weight double precision, rrf_k double precision, filter_municipality_id bigint) FROM PUBLIC;
GRANT ALL ON FUNCTION public.hybrid_search_bylaw_chunks(query_text text, query_embedding public.halfvec, match_count integer, full_text_weight double precision, semantic_weight double precision, rrf_k double precision, filter_municipality_id bigint) TO service_role;

--
-- Name: FUNCTION hybrid_search_document_sections(query_text text, query_embedding public.halfvec, match_count integer, full_text_weight double precision, semantic_weight double precision, rrf_k integer, date_from date, date_to date, filter_municipality_id bigint); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.hybrid_search_document_sections(query_text text, query_embedding public.halfvec, match_count integer, full_text_weight double precision, semantic_weight double precision, rrf_k integer, date_from date, date_to date, filter_municipality_id bigint) FROM PUBLIC;
GRANT ALL ON FUNCTION public.hybrid_search_document_sections(query_text text, query_embedding public.halfvec, match_count integer, full_text_weight double precision, semantic_weight double precision, rrf_k integer, date_from date, date_to date, filter_municipality_id bigint) TO service_role;

--
-- Name: FUNCTION hybrid_search_key_statements(query_text text, query_embedding public.halfvec, match_count integer, full_text_weight double precision, semantic_weight double precision, rrf_k integer); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.hybrid_search_key_statements(query_text text, query_embedding public.halfvec, match_count integer, full_text_weight double precision, semantic_weight double precision, rrf_k integer) FROM PUBLIC;
GRANT ALL ON FUNCTION public.hybrid_search_key_statements(query_text text, query_embedding public.halfvec, match_count integer, full_text_weight double precision, semantic_weight double precision, rrf_k integer) TO service_role;

--
-- Name: FUNCTION hybrid_search_key_statements(query_text text, query_embedding public.halfvec, match_count integer, full_text_weight double precision, semantic_weight double precision, rrf_k integer, date_from date, date_to date, filter_municipality_id bigint); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.hybrid_search_key_statements(query_text text, query_embedding public.halfvec, match_count integer, full_text_weight double precision, semantic_weight double precision, rrf_k integer, date_from date, date_to date, filter_municipality_id bigint) FROM PUBLIC;
GRANT ALL ON FUNCTION public.hybrid_search_key_statements(query_text text, query_embedding public.halfvec, match_count integer, full_text_weight double precision, semantic_weight double precision, rrf_k integer, date_from date, date_to date, filter_municipality_id bigint) TO service_role;

--
-- Name: FUNCTION hybrid_search_motions(query_text text, query_embedding public.halfvec, match_count integer, full_text_weight double precision, semantic_weight double precision, rrf_k integer); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.hybrid_search_motions(query_text text, query_embedding public.halfvec, match_count integer, full_text_weight double precision, semantic_weight double precision, rrf_k integer) FROM PUBLIC;
GRANT ALL ON FUNCTION public.hybrid_search_motions(query_text text, query_embedding public.halfvec, match_count integer, full_text_weight double precision, semantic_weight double precision, rrf_k integer) TO service_role;

--
-- Name: FUNCTION hybrid_search_motions(query_text text, query_embedding public.halfvec, match_count integer, full_text_weight double precision, semantic_weight double precision, rrf_k integer, date_from date, date_to date, filter_municipality_id bigint); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.hybrid_search_motions(query_text text, query_embedding public.halfvec, match_count integer, full_text_weight double precision, semantic_weight double precision, rrf_k integer, date_from date, date_to date, filter_municipality_id bigint) FROM PUBLIC;
GRANT ALL ON FUNCTION public.hybrid_search_motions(query_text text, query_embedding public.halfvec, match_count integer, full_text_weight double precision, semantic_weight double precision, rrf_k integer, date_from date, date_to date, filter_municipality_id bigint) TO service_role;

--
-- Name: FUNCTION invalidate_meeting_vimeo_cache(p_meeting_id bigint); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.invalidate_meeting_vimeo_cache(p_meeting_id bigint) FROM PUBLIC;
GRANT ALL ON FUNCTION public.invalidate_meeting_vimeo_cache(p_meeting_id bigint) TO service_role;

--
-- Name: FUNCTION is_public_input_item(p_title text, p_category text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.is_public_input_item(p_title text, p_category text) TO anon;
GRANT ALL ON FUNCTION public.is_public_input_item(p_title text, p_category text) TO authenticated;
GRANT ALL ON FUNCTION public.is_public_input_item(p_title text, p_category text) TO service_role;

--
-- Name: FUNCTION match_agenda_items(query_embedding public.halfvec, match_threshold double precision, match_count integer); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.match_agenda_items(query_embedding public.halfvec, match_threshold double precision, match_count integer) FROM PUBLIC;
GRANT ALL ON FUNCTION public.match_agenda_items(query_embedding public.halfvec, match_threshold double precision, match_count integer) TO service_role;

--
-- Name: FUNCTION match_agenda_items(query_embedding public.halfvec, match_threshold double precision, match_count integer, filter_municipality_id bigint); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.match_agenda_items(query_embedding public.halfvec, match_threshold double precision, match_count integer, filter_municipality_id bigint) FROM PUBLIC;
GRANT ALL ON FUNCTION public.match_agenda_items(query_embedding public.halfvec, match_threshold double precision, match_count integer, filter_municipality_id bigint) TO service_role;

--
-- Name: FUNCTION match_bylaw_chunks(query_embedding public.halfvec, match_threshold double precision, match_count integer, filter_bylaw_id bigint); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.match_bylaw_chunks(query_embedding public.halfvec, match_threshold double precision, match_count integer, filter_bylaw_id bigint) FROM PUBLIC;
GRANT ALL ON FUNCTION public.match_bylaw_chunks(query_embedding public.halfvec, match_threshold double precision, match_count integer, filter_bylaw_id bigint) TO service_role;

--
-- Name: FUNCTION match_bylaws(query_embedding public.halfvec, match_threshold double precision, match_count integer); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.match_bylaws(query_embedding public.halfvec, match_threshold double precision, match_count integer) FROM PUBLIC;
GRANT ALL ON FUNCTION public.match_bylaws(query_embedding public.halfvec, match_threshold double precision, match_count integer) TO service_role;

--
-- Name: FUNCTION match_bylaws(query_embedding public.halfvec, match_threshold double precision, match_count integer, filter_municipality_id bigint); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.match_bylaws(query_embedding public.halfvec, match_threshold double precision, match_count integer, filter_municipality_id bigint) FROM PUBLIC;
GRANT ALL ON FUNCTION public.match_bylaws(query_embedding public.halfvec, match_threshold double precision, match_count integer, filter_municipality_id bigint) TO service_role;

--
-- Name: FUNCTION match_document_sections(query_embedding public.halfvec, match_threshold double precision, match_count integer, filter_municipality_id bigint); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.match_document_sections(query_embedding public.halfvec, match_threshold double precision, match_count integer, filter_municipality_id bigint) FROM PUBLIC;
GRANT ALL ON FUNCTION public.match_document_sections(query_embedding public.halfvec, match_threshold double precision, match_count integer, filter_municipality_id bigint) TO service_role;

--
-- Name: FUNCTION match_key_statements(query_embedding public.halfvec, match_threshold double precision, match_count integer); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.match_key_statements(query_embedding public.halfvec, match_threshold double precision, match_count integer) FROM PUBLIC;
GRANT ALL ON FUNCTION public.match_key_statements(query_embedding public.halfvec, match_threshold double precision, match_count integer) TO service_role;

--
-- Name: FUNCTION match_key_statements(query_embedding public.halfvec, match_threshold double precision, match_count integer, filter_municipality_id bigint); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.match_key_statements(query_embedding public.halfvec, match_threshold double precision, match_count integer, filter_municipality_id bigint) FROM PUBLIC;
GRANT ALL ON FUNCTION public.match_key_statements(query_embedding public.halfvec, match_threshold double precision, match_count integer, filter_municipality_id bigint) TO service_role;

--
-- Name: FUNCTION match_key_statements_by_person(query_embedding public.halfvec, filter_person_id bigint, match_threshold double precision, match_count integer); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.match_key_statements_by_person(query_embedding public.halfvec, filter_person_id bigint, match_threshold double precision, match_count integer) FROM PUBLIC;
GRANT ALL ON FUNCTION public.match_key_statements_by_person(query_embedding public.halfvec, filter_person_id bigint, match_threshold double precision, match_count integer) TO service_role;

--
-- Name: FUNCTION match_matters(query_embedding public.halfvec, match_threshold double precision, match_count integer); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.match_matters(query_embedding public.halfvec, match_threshold double precision, match_count integer) FROM PUBLIC;
GRANT ALL ON FUNCTION public.match_matters(query_embedding public.halfvec, match_threshold double precision, match_count integer) TO service_role;

--
-- Name: FUNCTION match_matters(query_embedding public.halfvec, match_threshold double precision, match_count integer, filter_municipality_id bigint); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.match_matters(query_embedding public.halfvec, match_threshold double precision, match_count integer, filter_municipality_id bigint) FROM PUBLIC;
GRANT ALL ON FUNCTION public.match_matters(query_embedding public.halfvec, match_threshold double precision, match_count integer, filter_municipality_id bigint) TO service_role;

--
-- Name: FUNCTION match_motions(query_embedding public.halfvec, match_threshold double precision, match_count integer); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.match_motions(query_embedding public.halfvec, match_threshold double precision, match_count integer) FROM PUBLIC;
GRANT ALL ON FUNCTION public.match_motions(query_embedding public.halfvec, match_threshold double precision, match_count integer) TO service_role;

--
-- Name: FUNCTION match_motions(query_embedding public.halfvec, match_threshold double precision, match_count integer, filter_municipality_id bigint); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.match_motions(query_embedding public.halfvec, match_threshold double precision, match_count integer, filter_municipality_id bigint) FROM PUBLIC;
GRANT ALL ON FUNCTION public.match_motions(query_embedding public.halfvec, match_threshold double precision, match_count integer, filter_municipality_id bigint) TO service_role;

--
-- Name: FUNCTION match_motions_by_person(query_embedding public.halfvec, filter_person_id bigint, match_threshold double precision, match_count integer); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.match_motions_by_person(query_embedding public.halfvec, filter_person_id bigint, match_threshold double precision, match_count integer) FROM PUBLIC;
GRANT ALL ON FUNCTION public.match_motions_by_person(query_embedding public.halfvec, filter_person_id bigint, match_threshold double precision, match_count integer) TO service_role;

--
-- Name: FUNCTION match_review_examples(query_embedding public.halfvec, kind text, problem_type text, verdict_type text, k integer); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.match_review_examples(query_embedding public.halfvec, kind text, problem_type text, verdict_type text, k integer) FROM PUBLIC;
GRANT ALL ON FUNCTION public.match_review_examples(query_embedding public.halfvec, kind text, problem_type text, verdict_type text, k integer) TO service_role;

--
-- Name: FUNCTION matter_root(p_id bigint); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.matter_root(p_id bigint) TO anon;
GRANT ALL ON FUNCTION public.matter_root(p_id bigint) TO authenticated;
GRANT ALL ON FUNCTION public.matter_root(p_id bigint) TO service_role;

--
-- Name: FUNCTION matter_slug_base(title text, meta jsonb); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.matter_slug_base(title text, meta jsonb) TO anon;
GRANT ALL ON FUNCTION public.matter_slug_base(title text, meta jsonb) TO authenticated;
GRANT ALL ON FUNCTION public.matter_slug_base(title text, meta jsonb) TO service_role;

--
-- Name: FUNCTION merge_matters(p_canonical bigint, p_aliases bigint[], p_reason text, p_by text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.merge_matters(p_canonical bigint, p_aliases bigint[], p_reason text, p_by text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.merge_matters(p_canonical bigint, p_aliases bigint[], p_reason text, p_by text) TO service_role;

--
-- Name: FUNCTION normalize_category_to_topic(cat text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.normalize_category_to_topic(cat text) TO anon;
GRANT ALL ON FUNCTION public.normalize_category_to_topic(cat text) TO authenticated;
GRANT ALL ON FUNCTION public.normalize_category_to_topic(cat text) TO service_role;

--
-- Name: FUNCTION page_hidden(p_table text, p_id bigint); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.page_hidden(p_table text, p_id bigint) FROM PUBLIC;
GRANT ALL ON FUNCTION public.page_hidden(p_table text, p_id bigint) TO anon;
GRANT ALL ON FUNCTION public.page_hidden(p_table text, p_id bigint) TO authenticated;
GRANT ALL ON FUNCTION public.page_hidden(p_table text, p_id bigint) TO service_role;

--
-- Name: FUNCTION property_privacy_flags(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.property_privacy_flags() FROM PUBLIC;
GRANT ALL ON FUNCTION public.property_privacy_flags() TO service_role;

--
-- Name: FUNCTION public_participant_appearances(p_today date, p_municipality_id bigint, p_person_id bigint); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.public_participant_appearances(p_today date, p_municipality_id bigint, p_person_id bigint) FROM PUBLIC;
GRANT ALL ON FUNCTION public.public_participant_appearances(p_today date, p_municipality_id bigint, p_person_id bigint) TO service_role;

--
-- Name: FUNCTION publish_source_bound_key_statement(p_input_canonical_json text, p_input_sha256 text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.publish_source_bound_key_statement(p_input_canonical_json text, p_input_sha256 text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.publish_source_bound_key_statement(p_input_canonical_json text, p_input_sha256 text) TO service_role;

--
-- Name: FUNCTION reconcile_calendar_source(p_source_meeting_id bigint); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.reconcile_calendar_source(p_source_meeting_id bigint) FROM PUBLIC;
GRANT ALL ON FUNCTION public.reconcile_calendar_source(p_source_meeting_id bigint) TO service_role;

--
-- Name: FUNCTION record_email_provider_event(p_event_id text, p_provider_id text, p_type text, p_at timestamp with time zone, p_message uuid, p_recipient text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.record_email_provider_event(p_event_id text, p_provider_id text, p_type text, p_at timestamp with time zone, p_message uuid, p_recipient text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.record_email_provider_event(p_event_id text, p_provider_id text, p_type text, p_at timestamp with time zone, p_message uuid, p_recipient text) TO service_role;

--
-- Name: FUNCTION redirect_merged_matter(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.redirect_merged_matter() TO anon;
GRANT ALL ON FUNCTION public.redirect_merged_matter() TO authenticated;
GRANT ALL ON FUNCTION public.redirect_merged_matter() TO service_role;

--
-- Name: FUNCTION redirect_merged_matter_link(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.redirect_merged_matter_link() TO anon;
GRANT ALL ON FUNCTION public.redirect_merged_matter_link() TO authenticated;
GRANT ALL ON FUNCTION public.redirect_merged_matter_link() TO service_role;

--
-- Name: FUNCTION refresh_property_privacy(p_dry_run boolean); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.refresh_property_privacy(p_dry_run boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION public.refresh_property_privacy(p_dry_run boolean) TO service_role;

--
-- Name: FUNCTION rekey_about_matters(p_about jsonb); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.rekey_about_matters(p_about jsonb) TO anon;
GRANT ALL ON FUNCTION public.rekey_about_matters(p_about jsonb) TO authenticated;
GRANT ALL ON FUNCTION public.rekey_about_matters(p_about jsonb) TO service_role;

--
-- Name: FUNCTION repoint_matter_merges(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.repoint_matter_merges() TO anon;
GRANT ALL ON FUNCTION public.repoint_matter_merges() TO authenticated;
GRANT ALL ON FUNCTION public.repoint_matter_merges() TO service_role;

--
-- Name: FUNCTION rollback_transcript_identity_evidence(p_evidence_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.rollback_transcript_identity_evidence(p_evidence_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.rollback_transcript_identity_evidence(p_evidence_id uuid) TO service_role;

--
-- Name: FUNCTION search_daily_budget(p_limit integer, p_reserve boolean); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.search_daily_budget(p_limit integer, p_reserve boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION public.search_daily_budget(p_limit integer, p_reserve boolean) TO service_role;

--
-- Name: FUNCTION set_email_alert_consent(p_enabled boolean, p_complete_onboarding boolean); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.set_email_alert_consent(p_enabled boolean, p_complete_onboarding boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION public.set_email_alert_consent(p_enabled boolean, p_complete_onboarding boolean) TO authenticated;
GRANT ALL ON FUNCTION public.set_email_alert_consent(p_enabled boolean, p_complete_onboarding boolean) TO service_role;

--
-- Name: FUNCTION skip_own_mention(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.skip_own_mention() TO anon;
GRANT ALL ON FUNCTION public.skip_own_mention() TO authenticated;
GRANT ALL ON FUNCTION public.skip_own_mention() TO service_role;

--
-- Name: FUNCTION touch_public_content_version(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.touch_public_content_version() TO anon;
GRANT ALL ON FUNCTION public.touch_public_content_version() TO authenticated;
GRANT ALL ON FUNCTION public.touch_public_content_version() TO service_role;

--
-- Name: FUNCTION trigger_agenda_item_slug(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.trigger_agenda_item_slug() TO anon;
GRANT ALL ON FUNCTION public.trigger_agenda_item_slug() TO authenticated;
GRANT ALL ON FUNCTION public.trigger_agenda_item_slug() TO service_role;

--
-- Name: FUNCTION trigger_bylaw_slug(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.trigger_bylaw_slug() TO anon;
GRANT ALL ON FUNCTION public.trigger_bylaw_slug() TO authenticated;
GRANT ALL ON FUNCTION public.trigger_bylaw_slug() TO service_role;

--
-- Name: FUNCTION trigger_election_slug(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.trigger_election_slug() TO anon;
GRANT ALL ON FUNCTION public.trigger_election_slug() TO authenticated;
GRANT ALL ON FUNCTION public.trigger_election_slug() TO service_role;

--
-- Name: FUNCTION trigger_matter_slug(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.trigger_matter_slug() TO anon;
GRANT ALL ON FUNCTION public.trigger_matter_slug() TO authenticated;
GRANT ALL ON FUNCTION public.trigger_matter_slug() TO service_role;

--
-- Name: FUNCTION trigger_meeting_slug(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.trigger_meeting_slug() TO anon;
GRANT ALL ON FUNCTION public.trigger_meeting_slug() TO authenticated;
GRANT ALL ON FUNCTION public.trigger_meeting_slug() TO service_role;

--
-- Name: FUNCTION trigger_motion_slug(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.trigger_motion_slug() TO anon;
GRANT ALL ON FUNCTION public.trigger_motion_slug() TO authenticated;
GRANT ALL ON FUNCTION public.trigger_motion_slug() TO service_role;

--
-- Name: FUNCTION trigger_person_slug(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.trigger_person_slug() TO anon;
GRANT ALL ON FUNCTION public.trigger_person_slug() TO authenticated;
GRANT ALL ON FUNCTION public.trigger_person_slug() TO service_role;

--
-- Name: FUNCTION unsubscribe_email_alerts(p_token uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.unsubscribe_email_alerts(p_token uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.unsubscribe_email_alerts(p_token uuid) TO service_role;

--
-- Name: FUNCTION update_timestamp(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.update_timestamp() TO anon;
GRANT ALL ON FUNCTION public.update_timestamp() TO authenticated;
GRANT ALL ON FUNCTION public.update_timestamp() TO service_role;

--
-- Name: FUNCTION update_user_location(target_user_id uuid, lng double precision, lat double precision); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.update_user_location(target_user_id uuid, lng double precision, lat double precision) FROM PUBLIC;
GRANT ALL ON FUNCTION public.update_user_location(target_user_id uuid, lng double precision, lat double precision) TO service_role;
GRANT ALL ON FUNCTION public.update_user_location(target_user_id uuid, lng double precision, lat double precision) TO authenticated;

--
-- Name: TABLE agenda_item_topics; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.agenda_item_topics TO anon;
GRANT ALL ON TABLE public.agenda_item_topics TO authenticated;
GRANT ALL ON TABLE public.agenda_item_topics TO service_role;

--
-- Name: TABLE agenda_items; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.agenda_items TO anon;
GRANT ALL ON TABLE public.agenda_items TO authenticated;
GRANT ALL ON TABLE public.agenda_items TO service_role;

--
-- Name: SEQUENCE agenda_items_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.agenda_items_id_seq TO anon;
GRANT ALL ON SEQUENCE public.agenda_items_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.agenda_items_id_seq TO service_role;

--
-- Name: TABLE ai_usage; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.ai_usage TO anon;
GRANT ALL ON TABLE public.ai_usage TO authenticated;
GRANT ALL ON TABLE public.ai_usage TO service_role;

--
-- Name: TABLE ai_usage_by_job; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.ai_usage_by_job TO anon;
GRANT ALL ON TABLE public.ai_usage_by_job TO authenticated;
GRANT ALL ON TABLE public.ai_usage_by_job TO service_role;

--
-- Name: TABLE ai_usage_daily; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.ai_usage_daily TO service_role;

--
-- Name: SEQUENCE ai_usage_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.ai_usage_id_seq TO anon;
GRANT ALL ON SEQUENCE public.ai_usage_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.ai_usage_id_seq TO service_role;

--
-- Name: TABLE api_keys; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.api_keys TO anon;
GRANT ALL ON TABLE public.api_keys TO authenticated;
GRANT ALL ON TABLE public.api_keys TO service_role;

--
-- Name: TABLE attendance; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.attendance TO anon;
GRANT ALL ON TABLE public.attendance TO authenticated;
GRANT ALL ON TABLE public.attendance TO service_role;

--
-- Name: SEQUENCE attendance_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.attendance_id_seq TO anon;
GRANT ALL ON SEQUENCE public.attendance_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.attendance_id_seq TO service_role;

--
-- Name: TABLE bylaw_chunks; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.bylaw_chunks TO anon;
GRANT ALL ON TABLE public.bylaw_chunks TO authenticated;
GRANT ALL ON TABLE public.bylaw_chunks TO service_role;

--
-- Name: SEQUENCE bylaw_chunks_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.bylaw_chunks_id_seq TO anon;
GRANT ALL ON SEQUENCE public.bylaw_chunks_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.bylaw_chunks_id_seq TO service_role;

--
-- Name: TABLE bylaws; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.bylaws TO anon;
GRANT ALL ON TABLE public.bylaws TO authenticated;
GRANT ALL ON TABLE public.bylaws TO service_role;

--
-- Name: SEQUENCE bylaws_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.bylaws_id_seq TO anon;
GRANT ALL ON SEQUENCE public.bylaws_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.bylaws_id_seq TO service_role;

--
-- Name: TABLE calendar_sync_state; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.calendar_sync_state TO anon;
GRANT ALL ON TABLE public.calendar_sync_state TO authenticated;
GRANT ALL ON TABLE public.calendar_sync_state TO service_role;

--
-- Name: TABLE candidacies; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.candidacies TO anon;
GRANT ALL ON TABLE public.candidacies TO authenticated;
GRANT ALL ON TABLE public.candidacies TO service_role;

--
-- Name: SEQUENCE candidacies_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.candidacies_id_seq TO anon;
GRANT ALL ON SEQUENCE public.candidacies_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.candidacies_id_seq TO service_role;

--
-- Name: TABLE channel_posts; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.channel_posts TO service_role;

--
-- Name: TABLE computed_cache; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.computed_cache TO anon;
GRANT ALL ON TABLE public.computed_cache TO authenticated;
GRANT ALL ON TABLE public.computed_cache TO service_role;

--
-- Name: TABLE contact_messages; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.contact_messages TO service_role;

--
-- Name: TABLE council_terms; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.council_terms TO anon;
GRANT ALL ON TABLE public.council_terms TO authenticated;
GRANT ALL ON TABLE public.council_terms TO service_role;

--
-- Name: SEQUENCE council_terms_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.council_terms_id_seq TO anon;
GRANT ALL ON SEQUENCE public.council_terms_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.council_terms_id_seq TO service_role;

--
-- Name: TABLE councillor_highlights; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.councillor_highlights TO anon;
GRANT ALL ON TABLE public.councillor_highlights TO authenticated;
GRANT ALL ON TABLE public.councillor_highlights TO service_role;

--
-- Name: SEQUENCE councillor_highlights_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.councillor_highlights_id_seq TO anon;
GRANT ALL ON SEQUENCE public.councillor_highlights_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.councillor_highlights_id_seq TO service_role;

--
-- Name: TABLE councillor_stances; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.councillor_stances TO anon;
GRANT ALL ON TABLE public.councillor_stances TO authenticated;
GRANT ALL ON TABLE public.councillor_stances TO service_role;

--
-- Name: SEQUENCE councillor_stances_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.councillor_stances_id_seq TO anon;
GRANT ALL ON SEQUENCE public.councillor_stances_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.councillor_stances_id_seq TO service_role;

--
-- Name: TABLE data_reports; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.data_reports TO service_role;

--
-- Name: SEQUENCE data_reports_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.data_reports_id_seq TO anon;
GRANT ALL ON SEQUENCE public.data_reports_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.data_reports_id_seq TO service_role;

--
-- Name: TABLE document_images; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.document_images TO anon;
GRANT ALL ON TABLE public.document_images TO authenticated;
GRANT ALL ON TABLE public.document_images TO service_role;

--
-- Name: SEQUENCE document_images_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.document_images_id_seq TO anon;
GRANT ALL ON SEQUENCE public.document_images_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.document_images_id_seq TO service_role;

--
-- Name: TABLE document_sections; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.document_sections TO anon;
GRANT ALL ON TABLE public.document_sections TO authenticated;
GRANT ALL ON TABLE public.document_sections TO service_role;

--
-- Name: SEQUENCE document_sections_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.document_sections_id_seq TO anon;
GRANT ALL ON SEQUENCE public.document_sections_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.document_sections_id_seq TO service_role;

--
-- Name: TABLE documents; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.documents TO anon;
GRANT ALL ON TABLE public.documents TO authenticated;
GRANT ALL ON TABLE public.documents TO service_role;

--
-- Name: SEQUENCE documents_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.documents_id_seq TO anon;
GRANT ALL ON SEQUENCE public.documents_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.documents_id_seq TO service_role;

--
-- Name: TABLE election_offices; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.election_offices TO anon;
GRANT ALL ON TABLE public.election_offices TO authenticated;
GRANT ALL ON TABLE public.election_offices TO service_role;

--
-- Name: SEQUENCE election_offices_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.election_offices_id_seq TO anon;
GRANT ALL ON SEQUENCE public.election_offices_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.election_offices_id_seq TO service_role;

--
-- Name: TABLE elections; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.elections TO anon;
GRANT ALL ON TABLE public.elections TO authenticated;
GRANT ALL ON TABLE public.elections TO service_role;

--
-- Name: SEQUENCE elections_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.elections_id_seq TO anon;
GRANT ALL ON SEQUENCE public.elections_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.elections_id_seq TO service_role;

--
-- Name: TABLE email_enqueue_receipts; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.email_enqueue_receipts TO service_role;

--
-- Name: TABLE email_events; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.email_events TO service_role;

--
-- Name: TABLE email_suppressions; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.email_suppressions TO service_role;

--
-- Name: TABLE extracted_documents; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.extracted_documents TO anon;
GRANT ALL ON TABLE public.extracted_documents TO authenticated;
GRANT ALL ON TABLE public.extracted_documents TO service_role;

--
-- Name: SEQUENCE extracted_documents_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.extracted_documents_id_seq TO anon;
GRANT ALL ON SEQUENCE public.extracted_documents_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.extracted_documents_id_seq TO service_role;

--
-- Name: TABLE hidden_pages; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.hidden_pages TO service_role;

--
-- Name: TABLE key_statements; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.key_statements TO anon;
GRANT ALL ON TABLE public.key_statements TO authenticated;
GRANT ALL ON TABLE public.key_statements TO service_role;

--
-- Name: SEQUENCE key_statements_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.key_statements_id_seq TO anon;
GRANT ALL ON SEQUENCE public.key_statements_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.key_statements_id_seq TO service_role;

--
-- Name: TABLE key_votes; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.key_votes TO anon;
GRANT ALL ON TABLE public.key_votes TO authenticated;
GRANT ALL ON TABLE public.key_votes TO service_role;

--
-- Name: SEQUENCE key_votes_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.key_votes_id_seq TO anon;
GRANT ALL ON SEQUENCE public.key_votes_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.key_votes_id_seq TO service_role;

--
-- Name: TABLE matter_evidence; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.matter_evidence TO anon;
GRANT ALL ON TABLE public.matter_evidence TO authenticated;
GRANT ALL ON TABLE public.matter_evidence TO service_role;

--
-- Name: SEQUENCE matter_evidence_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.matter_evidence_id_seq TO anon;
GRANT ALL ON SEQUENCE public.matter_evidence_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.matter_evidence_id_seq TO service_role;

--
-- Name: TABLE matter_links; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.matter_links TO anon;
GRANT ALL ON TABLE public.matter_links TO authenticated;
GRANT ALL ON TABLE public.matter_links TO service_role;

--
-- Name: SEQUENCE matter_links_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.matter_links_id_seq TO anon;
GRANT ALL ON SEQUENCE public.matter_links_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.matter_links_id_seq TO service_role;

--
-- Name: TABLE matter_merge_proposals; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.matter_merge_proposals TO anon;
GRANT ALL ON TABLE public.matter_merge_proposals TO authenticated;
GRANT ALL ON TABLE public.matter_merge_proposals TO service_role;

--
-- Name: SEQUENCE matter_merge_proposals_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.matter_merge_proposals_id_seq TO anon;
GRANT ALL ON SEQUENCE public.matter_merge_proposals_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.matter_merge_proposals_id_seq TO service_role;

--
-- Name: TABLE matter_merges; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.matter_merges TO service_role;

--
-- Name: SEQUENCE matter_merges_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.matter_merges_id_seq TO anon;
GRANT ALL ON SEQUENCE public.matter_merges_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.matter_merges_id_seq TO service_role;

--
-- Name: TABLE matter_report_mentions; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.matter_report_mentions TO service_role;
GRANT SELECT ON TABLE public.matter_report_mentions TO anon;
GRANT SELECT ON TABLE public.matter_report_mentions TO authenticated;

--
-- Name: SEQUENCE matter_report_mentions_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.matter_report_mentions_id_seq TO anon;
GRANT ALL ON SEQUENCE public.matter_report_mentions_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.matter_report_mentions_id_seq TO service_role;

--
-- Name: TABLE matters; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.matters TO anon;
GRANT ALL ON TABLE public.matters TO authenticated;
GRANT ALL ON TABLE public.matters TO service_role;

--
-- Name: SEQUENCE matters_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.matters_id_seq TO anon;
GRANT ALL ON SEQUENCE public.matters_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.matters_id_seq TO service_role;

--
-- Name: TABLE meeting_events; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.meeting_events TO anon;
GRANT ALL ON TABLE public.meeting_events TO authenticated;
GRANT ALL ON TABLE public.meeting_events TO service_role;

--
-- Name: SEQUENCE meeting_events_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.meeting_events_id_seq TO anon;
GRANT ALL ON SEQUENCE public.meeting_events_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.meeting_events_id_seq TO service_role;

--
-- Name: TABLE meeting_slug_history; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.meeting_slug_history TO anon;
GRANT ALL ON TABLE public.meeting_slug_history TO authenticated;
GRANT ALL ON TABLE public.meeting_slug_history TO service_role;

--
-- Name: SEQUENCE meeting_slug_history_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.meeting_slug_history_id_seq TO anon;
GRANT ALL ON SEQUENCE public.meeting_slug_history_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.meeting_slug_history_id_seq TO service_role;

--
-- Name: TABLE meeting_speaker_aliases; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.meeting_speaker_aliases TO anon;
GRANT ALL ON TABLE public.meeting_speaker_aliases TO authenticated;
GRANT ALL ON TABLE public.meeting_speaker_aliases TO service_role;

--
-- Name: SEQUENCE meeting_speaker_aliases_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.meeting_speaker_aliases_id_seq TO anon;
GRANT ALL ON SEQUENCE public.meeting_speaker_aliases_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.meeting_speaker_aliases_id_seq TO service_role;

--
-- Name: TABLE meetings; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.meetings TO anon;
GRANT ALL ON TABLE public.meetings TO authenticated;
GRANT ALL ON TABLE public.meetings TO service_role;

--
-- Name: SEQUENCE meetings_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.meetings_id_seq TO anon;
GRANT ALL ON SEQUENCE public.meetings_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.meetings_id_seq TO service_role;

--
-- Name: TABLE memberships; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.memberships TO anon;
GRANT ALL ON TABLE public.memberships TO authenticated;
GRANT ALL ON TABLE public.memberships TO service_role;

--
-- Name: SEQUENCE memberships_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.memberships_id_seq TO anon;
GRANT ALL ON SEQUENCE public.memberships_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.memberships_id_seq TO service_role;

--
-- Name: TABLE motions; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.motions TO anon;
GRANT ALL ON TABLE public.motions TO authenticated;
GRANT ALL ON TABLE public.motions TO service_role;

--
-- Name: SEQUENCE motions_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.motions_id_seq TO anon;
GRANT ALL ON SEQUENCE public.motions_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.motions_id_seq TO service_role;

--
-- Name: TABLE municipalities; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.municipalities TO service_role;
GRANT SELECT ON TABLE public.municipalities TO anon;
GRANT SELECT ON TABLE public.municipalities TO authenticated;

--
-- Name: SEQUENCE municipalities_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.municipalities_id_seq TO service_role;

--
-- Name: TABLE ocd_divisions; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.ocd_divisions TO anon;
GRANT ALL ON TABLE public.ocd_divisions TO authenticated;
GRANT ALL ON TABLE public.ocd_divisions TO service_role;

--
-- Name: SEQUENCE ocd_divisions_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.ocd_divisions_id_seq TO anon;
GRANT ALL ON SEQUENCE public.ocd_divisions_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.ocd_divisions_id_seq TO service_role;

--
-- Name: TABLE organizations; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.organizations TO anon;
GRANT ALL ON TABLE public.organizations TO authenticated;
GRANT ALL ON TABLE public.organizations TO service_role;

--
-- Name: SEQUENCE organizations_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.organizations_id_seq TO anon;
GRANT ALL ON SEQUENCE public.organizations_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.organizations_id_seq TO service_role;

--
-- Name: TABLE page_reviews; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.page_reviews TO service_role;

--
-- Name: TABLE people; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.people TO anon;
GRANT ALL ON TABLE public.people TO authenticated;
GRANT ALL ON TABLE public.people TO service_role;

--
-- Name: SEQUENCE people_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.people_id_seq TO anon;
GRANT ALL ON SEQUENCE public.people_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.people_id_seq TO service_role;

--
-- Name: SEQUENCE pipeline_jobs_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.pipeline_jobs_id_seq TO anon;
GRANT ALL ON SEQUENCE public.pipeline_jobs_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.pipeline_jobs_id_seq TO service_role;

--
-- Name: TABLE pipeline_run_events; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.pipeline_run_events TO anon;
GRANT ALL ON TABLE public.pipeline_run_events TO authenticated;
GRANT ALL ON TABLE public.pipeline_run_events TO service_role;

--
-- Name: SEQUENCE pipeline_run_events_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.pipeline_run_events_id_seq TO anon;
GRANT ALL ON SEQUENCE public.pipeline_run_events_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.pipeline_run_events_id_seq TO service_role;

--
-- Name: TABLE properties; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,MAINTAIN ON TABLE public.properties TO anon;
GRANT SELECT,MAINTAIN ON TABLE public.properties TO authenticated;
GRANT ALL ON TABLE public.properties TO service_role;

--
-- Name: SEQUENCE properties_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.properties_id_seq TO anon;
GRANT ALL ON SEQUENCE public.properties_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.properties_id_seq TO service_role;

--
-- Name: TABLE property_links; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,MAINTAIN ON TABLE public.property_links TO anon;
GRANT SELECT,MAINTAIN ON TABLE public.property_links TO authenticated;
GRANT ALL ON TABLE public.property_links TO service_role;

--
-- Name: SEQUENCE property_links_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.property_links_id_seq TO anon;
GRANT ALL ON SEQUENCE public.property_links_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.property_links_id_seq TO service_role;

--
-- Name: TABLE public_content_version; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.public_content_version TO anon;
GRANT ALL ON TABLE public.public_content_version TO authenticated;
GRANT ALL ON TABLE public.public_content_version TO service_role;

--
-- Name: TABLE public_report_pages; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.public_report_pages TO service_role;
GRANT SELECT ON TABLE public.public_report_pages TO anon;
GRANT SELECT ON TABLE public.public_report_pages TO authenticated;

--
-- Name: TABLE public_reports; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.public_reports TO service_role;
GRANT SELECT ON TABLE public.public_reports TO anon;
GRANT SELECT ON TABLE public.public_reports TO authenticated;

--
-- Name: SEQUENCE public_reports_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.public_reports_id_seq TO anon;
GRANT ALL ON SEQUENCE public.public_reports_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.public_reports_id_seq TO service_role;

--
-- Name: TABLE public_speaker_names; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.public_speaker_names TO anon;
GRANT ALL ON TABLE public.public_speaker_names TO authenticated;
GRANT ALL ON TABLE public.public_speaker_names TO service_role;

--
-- Name: SEQUENCE public_speaker_names_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.public_speaker_names_id_seq TO anon;
GRANT ALL ON SEQUENCE public.public_speaker_names_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.public_speaker_names_id_seq TO service_role;

--
-- Name: TABLE rag_feedback; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.rag_feedback TO service_role;

--
-- Name: TABLE rag_traces; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.rag_traces TO service_role;

--
-- Name: TABLE review_examples; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.review_examples TO service_role;

--
-- Name: SEQUENCE review_examples_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.review_examples_id_seq TO anon;
GRANT ALL ON SEQUENCE public.review_examples_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.review_examples_id_seq TO service_role;

--
-- Name: TABLE review_guidance; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.review_guidance TO service_role;

--
-- Name: SEQUENCE review_guidance_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.review_guidance_id_seq TO anon;
GRANT ALL ON SEQUENCE public.review_guidance_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.review_guidance_id_seq TO service_role;

--
-- Name: TABLE search_daily_usage; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.search_daily_usage TO service_role;

--
-- Name: TABLE search_results_cache; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.search_results_cache TO service_role;

--
-- Name: TABLE server_metrics; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.server_metrics TO service_role;

--
-- Name: TABLE source_meetings; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.source_meetings TO anon;
GRANT ALL ON TABLE public.source_meetings TO authenticated;
GRANT ALL ON TABLE public.source_meetings TO service_role;

--
-- Name: SEQUENCE source_meetings_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.source_meetings_id_seq TO anon;
GRANT ALL ON SEQUENCE public.source_meetings_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.source_meetings_id_seq TO service_role;

--
-- Name: TABLE staff_actions; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.staff_actions TO service_role;

--
-- Name: SEQUENCE staff_actions_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.staff_actions_id_seq TO anon;
GRANT ALL ON SEQUENCE public.staff_actions_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.staff_actions_id_seq TO service_role;

--
-- Name: TABLE subscriptions; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.subscriptions TO anon;
GRANT ALL ON TABLE public.subscriptions TO authenticated;
GRANT ALL ON TABLE public.subscriptions TO service_role;

--
-- Name: SEQUENCE subscriptions_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.subscriptions_id_seq TO anon;
GRANT ALL ON SEQUENCE public.subscriptions_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.subscriptions_id_seq TO service_role;

--
-- Name: TABLE topics; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.topics TO anon;
GRANT ALL ON TABLE public.topics TO authenticated;
GRANT ALL ON TABLE public.topics TO service_role;

--
-- Name: SEQUENCE topics_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.topics_id_seq TO anon;
GRANT ALL ON SEQUENCE public.topics_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.topics_id_seq TO service_role;

--
-- Name: TABLE transcript_identity_evidence; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.transcript_identity_evidence TO service_role;

--
-- Name: TABLE transcript_segments; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.transcript_segments TO anon;
GRANT ALL ON TABLE public.transcript_segments TO authenticated;
GRANT ALL ON TABLE public.transcript_segments TO service_role;

--
-- Name: SEQUENCE transcript_segments_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.transcript_segments_id_seq TO anon;
GRANT ALL ON SEQUENCE public.transcript_segments_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.transcript_segments_id_seq TO service_role;

--
-- Name: TABLE user_profiles; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.user_profiles TO anon;
GRANT ALL ON TABLE public.user_profiles TO authenticated;
GRANT ALL ON TABLE public.user_profiles TO service_role;

--
-- Name: TABLE user_roles; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.user_roles TO service_role;

--
-- Name: TABLE voice_exemplars; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.voice_exemplars TO service_role;

--
-- Name: SEQUENCE voice_exemplars_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.voice_exemplars_id_seq TO anon;
GRANT ALL ON SEQUENCE public.voice_exemplars_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.voice_exemplars_id_seq TO service_role;

--
-- Name: TABLE voice_fingerprints; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.voice_fingerprints TO service_role;

--
-- Name: TABLE votes; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.votes TO anon;
GRANT ALL ON TABLE public.votes TO authenticated;
GRANT ALL ON TABLE public.votes TO service_role;

--
-- Name: SEQUENCE votes_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.votes_id_seq TO anon;
GRANT ALL ON SEQUENCE public.votes_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.votes_id_seq TO service_role;

--
-- Name: DEFAULT PRIVILEGES FOR SEQUENCES; Type: DEFAULT ACL; Schema: public; Owner: -
--

--
-- Name: DEFAULT PRIVILEGES FOR SEQUENCES; Type: DEFAULT ACL; Schema: public; Owner: -
--

--
-- Name: DEFAULT PRIVILEGES FOR FUNCTIONS; Type: DEFAULT ACL; Schema: public; Owner: -
--

--
-- Name: DEFAULT PRIVILEGES FOR FUNCTIONS; Type: DEFAULT ACL; Schema: public; Owner: -
--

--
-- Name: DEFAULT PRIVILEGES FOR TABLES; Type: DEFAULT ACL; Schema: public; Owner: -
--

--
-- Name: DEFAULT PRIVILEGES FOR TABLES; Type: DEFAULT ACL; Schema: public; Owner: -
--

--
-- PostgreSQL database dump complete
--

