-- The merged-topic pointer lives only in matters.merged_into now. Every reader moved to the column (web, pipeline, and
-- the SQL functions below), so the old JSON copies (meta.canonical_matter_id on a merged topic, meta.merged_matter_ids
-- on its main topic) stop being written and are removed. meta.merge_reason stays as a note.

CREATE OR REPLACE FUNCTION public.property_privacy_flags()
RETURNS TABLE(id bigint, hide boolean) LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
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
REVOKE ALL ON FUNCTION public.property_privacy_flags() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.property_privacy_flags() TO service_role;

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

REVOKE ALL ON FUNCTION public.council_term_stats(bigint, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.council_term_stats(bigint, date) TO service_role;

CREATE OR REPLACE FUNCTION public.merge_matters(p_canonical bigint, p_aliases bigint[], p_reason text, p_by text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
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
END $$;

REVOKE ALL ON FUNCTION public.merge_matters(bigint, bigint[], text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.merge_matters(bigint, bigint[], text, text) TO service_role;

UPDATE public.matters SET meta = meta - 'canonical_matter_id' - 'merged_matter_ids'
WHERE meta ? 'canonical_matter_id' OR meta ? 'merged_matter_ids';
