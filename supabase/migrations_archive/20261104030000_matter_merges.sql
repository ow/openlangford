-- Merged topics, done once and in one place.
--
-- Until now a merge only pointed the old topic at its main topic (meta.canonical_matter_id) and left its agenda items,
-- links and the rest behind, so every reader had to follow the pointer itself; the ones that forgot showed raw titles,
-- split counts and stale summaries. This adds:
--   * matters.merged_into: the pointer as a real column (one hop, kept flat by a trigger);
--   * matter_merges: what each merge moved and removed, for audit and a later unmerge;
--   * merge_matters(): the one merge, which moves every reference onto the main topic, collapsing duplicates;
--   * redirect triggers: anything written against a merged topic lands on its main topic.
-- The meta keys (canonical_matter_id, merged_matter_ids) are still written, because listings filter on them.
-- Existing merges are only marked here; moving their rows is a separate, backed-up script.

ALTER TABLE public.matters ADD COLUMN IF NOT EXISTS merged_into bigint REFERENCES public.matters(id) ON DELETE SET NULL;
DO $$ BEGIN
  ALTER TABLE public.matters ADD CONSTRAINT matters_merged_into_not_self CHECK (merged_into IS NULL OR merged_into <> id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS matters_merged_into_idx ON public.matters (merged_into) WHERE merged_into IS NOT NULL;

UPDATE public.matters m SET merged_into = c.id
FROM public.matters c
WHERE m.merged_into IS NULL AND m.meta->>'canonical_matter_id' ~ '^[0-9]+$'
  AND c.id = (m.meta->>'canonical_matter_id')::bigint AND c.id <> m.id;

CREATE TABLE IF NOT EXISTS public.matter_merges (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  canonical_id bigint NOT NULL,
  alias_ids bigint[] NOT NULL,
  reason text,
  merged_by text,
  merged_at timestamptz NOT NULL DEFAULT now(),
  moved jsonb NOT NULL DEFAULT '{}'::jsonb,    -- ids of rows re-pointed, per table
  removed jsonb NOT NULL DEFAULT '{}'::jsonb,  -- full rows deleted as duplicates or self-links, per table
  notes jsonb NOT NULL DEFAULT '[]'::jsonb
);
ALTER TABLE public.matter_merges ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.matter_merges FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON public.matter_merges TO service_role;

-- The topic a reference should land on. One hop: the matters trigger keeps merged_into flat. Security definer
-- because the redirect triggers run as whoever writes (a signed-in resident adding a subscription, say); it returns
-- only an id.
CREATE OR REPLACE FUNCTION public.matter_root(p_id bigint) RETURNS bigint
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE((SELECT merged_into FROM matters WHERE id = p_id), p_id)
$$;

CREATE OR REPLACE FUNCTION public.flatten_matter_merge() RETURNS trigger
LANGUAGE plpgsql SET search_path = public AS $$
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

-- A topic merged away takes the topics already merged into it along.
CREATE OR REPLACE FUNCTION public.repoint_matter_merges() RETURNS trigger
LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NEW.merged_into IS NOT NULL THEN
    UPDATE matters SET merged_into = NEW.merged_into WHERE merged_into = NEW.id;
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS flatten_matter_merge ON public.matters;
CREATE TRIGGER flatten_matter_merge BEFORE INSERT OR UPDATE OF merged_into ON public.matters
  FOR EACH ROW EXECUTE FUNCTION public.flatten_matter_merge();
DROP TRIGGER IF EXISTS repoint_matter_merges ON public.matters;
CREATE TRIGGER repoint_matter_merges AFTER UPDATE OF merged_into ON public.matters
  FOR EACH ROW WHEN (NEW.merged_into IS DISTINCT FROM OLD.merged_into) EXECUTE FUNCTION public.repoint_matter_merges();

CREATE OR REPLACE FUNCTION public.redirect_merged_matter() RETURNS trigger
LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NEW.matter_id IS NOT NULL THEN NEW.matter_id := matter_root(NEW.matter_id); END IF;
  RETURN NEW;
END $$;

-- A related-topic link whose two ends turn out to be one topic is dropped (the table forbids self-links).
CREATE OR REPLACE FUNCTION public.redirect_merged_matter_link() RETURNS trigger
LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  NEW.matter_id := matter_root(NEW.matter_id);
  IF NEW.related_matter_id IS NOT NULL THEN
    NEW.related_matter_id := matter_root(NEW.related_matter_id);
    IF NEW.related_matter_id = NEW.matter_id THEN RETURN NULL; END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS redirect_merged_matter ON public.agenda_items;
CREATE TRIGGER redirect_merged_matter BEFORE INSERT OR UPDATE OF matter_id ON public.agenda_items
  FOR EACH ROW EXECUTE FUNCTION public.redirect_merged_matter();
DROP TRIGGER IF EXISTS redirect_merged_matter ON public.property_links;
CREATE TRIGGER redirect_merged_matter BEFORE INSERT OR UPDATE OF matter_id ON public.property_links
  FOR EACH ROW EXECUTE FUNCTION public.redirect_merged_matter();
DROP TRIGGER IF EXISTS redirect_merged_matter ON public.matter_report_mentions;
CREATE TRIGGER redirect_merged_matter BEFORE INSERT OR UPDATE OF matter_id ON public.matter_report_mentions
  FOR EACH ROW EXECUTE FUNCTION public.redirect_merged_matter();
DROP TRIGGER IF EXISTS redirect_merged_matter ON public.matter_evidence;
CREATE TRIGGER redirect_merged_matter BEFORE INSERT OR UPDATE OF matter_id ON public.matter_evidence
  FOR EACH ROW EXECUTE FUNCTION public.redirect_merged_matter();
DROP TRIGGER IF EXISTS redirect_merged_matter ON public.subscriptions;
CREATE TRIGGER redirect_merged_matter BEFORE INSERT OR UPDATE OF matter_id ON public.subscriptions
  FOR EACH ROW EXECUTE FUNCTION public.redirect_merged_matter();
DROP TRIGGER IF EXISTS redirect_merged_matter ON public.matter_links;
CREATE TRIGGER redirect_merged_matter BEFORE INSERT OR UPDATE OF matter_id, related_matter_id ON public.matter_links
  FOR EACH ROW EXECUTE FUNCTION public.redirect_merged_matter_link();

-- Merge p_aliases (and anything already merged into them or into the canonical) into p_canonical, moving every
-- reference. Duplicates collapse to one row: a staff removal or rejection wins, then a staff acceptance, then the
-- canonical's own row (automatic checks judge mentions against canonicals only), then a visible one, then one with a quote. Calling it again for an already-merged topic only moves what is still left behind.
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
