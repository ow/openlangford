-- Merges also re-key the topic ids that comments store (agenda_items.meta.participation.about_matters maps a topic id
-- to the speakers who addressed it) and carry over a map location only a merged topic had. Fixes the 118 keys left on
-- merged topics by the backfill.

-- Each key resolved to the topic it now belongs to; keys that land on the same topic have their speaker lists combined.
CREATE OR REPLACE FUNCTION public.rekey_about_matters(p_about jsonb) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT coalesce(jsonb_object_agg(root, idx), '{}'::jsonb) FROM (
    SELECT root, coalesce(jsonb_agg(DISTINCT e ORDER BY e) FILTER (WHERE e IS NOT NULL), '[]'::jsonb) AS idx
      FROM (SELECT CASE WHEN j.k ~ '^[0-9]+$' THEN matter_root(j.k::bigint)::text ELSE j.k END AS root, e
              FROM jsonb_each(p_about) AS j(k, v)
              LEFT JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(j.v) = 'array' THEN j.v ELSE '[]'::jsonb END) AS e ON true) x
     GROUP BY root) y
$$;

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

  -- The canonical spans everyone's dates and lists its aliases; aliases keep their notes but lose public text.
  UPDATE matters c SET
    first_seen = (SELECT min(first_seen) FROM matters WHERE id = ANY(v_all)),
    last_seen = (SELECT max(last_seen) FROM matters WHERE id = ANY(v_all)),
    meta = (coalesce(c.meta, '{}'::jsonb) - 'canonical_matter_id') || jsonb_build_object('merged_matter_ids', to_jsonb(v_aliases))
  WHERE c.id = p_canonical;
  UPDATE matters a SET
    plain_english_summary = NULL,
    embedding = NULL,
    meta = (coalesce(a.meta, '{}'::jsonb) - 'merged_matter_ids' - 'display_title' - 'status_line')
           || jsonb_build_object('canonical_matter_id', p_canonical)
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

UPDATE public.agenda_items a SET meta = jsonb_set(a.meta, '{participation,about_matters}', public.rekey_about_matters(a.meta->'participation'->'about_matters'))
WHERE jsonb_typeof(a.meta->'participation'->'about_matters') = 'object'
  AND EXISTS (SELECT 1 FROM jsonb_object_keys(a.meta->'participation'->'about_matters') k
               JOIN public.matters m ON k ~ '^[0-9]+$' AND m.id = k::bigint WHERE m.merged_into IS NOT NULL);
