-- Term-level counts for the council page: meetings held, decisions, bylaws adopted and the busiest topics.
-- Read-only; counts only what the record states (motion results as minuted, adoption motions as worded).

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
    COALESCE((SELECT jsonb_agg(jsonb_build_object('title', tc.title, 'slug', tc.slug, 'meetings', tc.meetings) ORDER BY tc.rank)
      FROM topic_counts tc WHERE tc.term_id = term.id AND tc.rank <= 5), '[]'::jsonb)
  FROM term;
$$;

REVOKE ALL ON FUNCTION public.council_term_stats(bigint, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.council_term_stats(bigint, date) TO service_role;
