-- Term stats gain meetings per month and residents' input (spoken comments, letters, stance, the topics they
-- addressed most). The return type changes, so the function is dropped and recreated.

DROP FUNCTION IF EXISTS public.council_term_stats(bigint, date);

CREATE OR REPLACE FUNCTION public.council_term_stats(p_municipality_id bigint, p_as_of date)
RETURNS TABLE (
  term_id bigint,
  meetings integer,
  regular_council integer,
  special_council integer,
  committee_of_the_whole integer,
  committees integer,
  motions_carried integer,
  motions_defeated integer,
  bylaws_adopted integer,
  bylaw_adoption_dates jsonb,
  motions_by_month jsonb,
  meetings_by_month jsonb,
  spoken_comments integer,
  letters integer,
  public_supports integer,
  public_opposes integer,
  public_topics jsonb,
  topics jsonb
)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public
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
      FROM input_topics it JOIN matters mt ON mt.id = it.matter_id
      GROUP BY it.term_id, mt.id, mt.slug, mt.meta->>'display_title', mt.title
    ) per_topic
    GROUP BY term_id, title
  ),
  topic_counts AS (
    SELECT held.term_id, mt.id, COALESCE(NULLIF(mt.meta->>'display_title', ''), mt.title) AS title, mt.slug, COUNT(DISTINCT held.id) AS meetings,
      ROW_NUMBER() OVER (PARTITION BY held.term_id ORDER BY COUNT(DISTINCT held.id) DESC, MAX(a.id) DESC) AS rank
    FROM held
    JOIN agenda_items a ON a.meeting_id = held.id
    JOIN matters mt ON mt.id = a.matter_id
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

REVOKE ALL ON FUNCTION public.council_term_stats(bigint, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.council_term_stats(bigint, date) TO service_role;
