-- Additive, read-only aggregation for /participants and /participants/:id.
--
-- The web app used to page through every identified transcript segment (~135k rows, ~136 offset requests per
-- rebuild) only to sum seconds, count segments and take the earliest start per (person, meeting, agenda item).
-- This returns those appearances instead (~2.3k rows, one request). Every privacy rule (council and staff
-- service, committee members on their own committee, excluded role terms, meta->participant_roles, anonymous
-- speaker names) stays in apps/web/app/services/people.ts, which reads these rows exactly as it read segments.
--
-- p_today is the caller's civic day (civicToday() in the web app), so "no future meetings" means the same thing
-- on both sides. Rows come back in order of each appearance's first segment id, the order the web code used to
-- meet them in; seconds are summed in segment id order so they match the old per-segment sums exactly.
-- One jsonb value rather than a row set: PostgREST caps RPC row sets at max_rows (1000).
--
-- The covering index lets the full rebuild read ~10 MB of index in group order instead of seq-scanning the
-- ~130 MB heap (text and all) and sorting 135k rows on disk. Building it takes a second or two on ~200k rows;
-- writes to transcript_segments wait for that.

CREATE INDEX IF NOT EXISTS transcript_segments_person_appearance_idx
  ON public.transcript_segments (person_id, meeting_id, agenda_item_id, id)
  INCLUDE (start_time, end_time)
  WHERE person_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.public_participant_appearances(
  p_today date,
  p_municipality_id bigint DEFAULT NULL,
  p_person_id bigint DEFAULT NULL
)
RETURNS jsonb
LANGUAGE sql STABLE
SET search_path = public
-- jsonb takes float8 through its text form; without this a session at extra_float_digits = 0 (the pooler's
-- default here) rounds seconds to 15 significant digits, which the old per-segment sums did not.
SET extra_float_digits = 3
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

REVOKE ALL ON FUNCTION public.public_participant_appearances(date, bigint, bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.public_participant_appearances(date, bigint, bigint) TO service_role;
