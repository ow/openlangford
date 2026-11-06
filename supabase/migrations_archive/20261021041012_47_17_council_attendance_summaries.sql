-- Additive, read-only aggregation. Apply before activating the new web caller.
-- No attendance records, memberships or evidence are changed.
BEGIN;

CREATE OR REPLACE FUNCTION public._council_attendance_trim(value text)
RETURNS text LANGUAGE sql IMMUTABLE STRICT SET search_path = public
AS $$
  -- ECMAScript String.trim whitespace, including NBSP/BOM (not arbitrary Unicode space).
  SELECT btrim(value, E' \t\n\r\f\v' || U&'\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF');
$$;

CREATE OR REPLACE FUNCTION public._council_attendance_js_text(value json)
RETURNS text LANGUAGE plpgsql IMMUTABLE STRICT SET search_path = public
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

CREATE OR REPLACE FUNCTION public._council_attendance_state(
  p_notes text, p_mode text, p_meeting_id bigint, p_person_id bigint, p_date date
) RETURNS TABLE(state text, verified boolean)
LANGUAGE plpgsql IMMUTABLE SET search_path = public
AS $$
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
      AND evidence ->> 'method' IN ('original_roster', 'original_minutes_attendance')
      AND evidence ->> 'state' IN ('present', 'absent')
      AND json_typeof(evidence -> 'person_id') = 'number'
      AND (evidence ->> 'person_id')::double precision = p_person_id::double precision
      AND json_typeof(evidence -> 'meeting_id') = 'number'
      AND (evidence ->> 'meeting_id')::double precision = p_meeting_id::double precision
      AND public._council_attendance_js_text(evidence -> 'source_url') ~ '^https://'
      AND public._council_attendance_js_text(evidence -> 'source_sha256') ~ '^[a-f0-9]{64}$'
      AND page >= 1 AND page < 'Infinity'::double precision AND page = trunc(page)
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
$$;

CREATE OR REPLACE FUNCTION public.council_attendance_summaries(
  p_municipality_id bigint,
  p_as_of date DEFAULT ((CURRENT_TIMESTAMP AT TIME ZONE 'America/Vancouver')::date)
) RETURNS TABLE(person_id bigint, term_key text, total integer, attended integer, absent integer, unknown integer, verified integer, recorded integer, rate integer)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = public
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

REVOKE ALL ON FUNCTION public._council_attendance_trim(text), public._council_attendance_js_text(json), public._council_attendance_state(text,text,bigint,bigint,date), public.council_attendance_summaries(bigint,date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._council_attendance_trim(text), public._council_attendance_js_text(json), public._council_attendance_state(text,text,bigint,bigint,date), public.council_attendance_summaries(bigint,date) TO service_role;
NOTIFY pgrst, 'reload schema';
COMMIT;
