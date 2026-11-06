-- Attendance evidence may also be a member saying their own name on the meeting video (the oath of office at the
-- 2026-11-02 inaugural meeting, which has no minutes). Same function signature; only widens what counts as evidence.
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
$$;
