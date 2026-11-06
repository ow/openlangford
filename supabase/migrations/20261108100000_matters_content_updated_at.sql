-- matters.content_updated_at: when something a reader sees on the topic page last changed.
--
-- matters.updated_at is a write stamp (update_timestamp bumps it on every UPDATE, so one backfill
-- touched 1,573 topics in an hour) and can't tell search engines anything. This column moves only when:
--   * a visible matters field changes (title, summary, status, the display title / status line /
--     timeline wording / picture in meta, hiding or merging the page), or
--   * an entry on the page is added, removed, hidden or moved: agenda_items.matter_id, and visible rows of
--     matter_links (mentions and related topics), matter_evidence and matter_report_mentions.
-- AI version stamps, review notes and other bookkeeping in meta do not count.
--
-- Safe on live data: the column is nullable (a metadata-only ADD), existing topics are backfilled to the
-- date they were last taken up at a meeting rather than now() (stamping every page as changed today would
-- look like a mass edit), and the backfill runs before the triggers exist.

ALTER TABLE public.matters ADD COLUMN IF NOT EXISTS content_updated_at timestamp with time zone;

UPDATE public.matters
SET content_updated_at = COALESCE(last_seen::timestamptz, first_seen::timestamptz, created_at)
WHERE content_updated_at IS NULL;

ALTER TABLE public.matters ALTER COLUMN content_updated_at SET DEFAULT now();

COMMENT ON COLUMN public.matters.content_updated_at IS
  'When something a reader sees on the topic page last changed (maintained by triggers; see stamp_matter_content). Use this, not updated_at, for freshness.';

-- BEFORE INSERT OR UPDATE on matters. An UPDATE that sets content_updated_at itself (the bump from the
-- child-table triggers below, or a deliberate correction) is left alone, so the bump never re-triggers.
--
-- Visible meta keys are the ones the topic page reads (matter-detail.tsx, lib/display-text.ts matterTitle):
--   display_title (heading), status_line (Status box), entry_lines and timeline_headlines (timeline wording),
--   images (lead photo, site plan), hidden (page hidden or removed), hidden_duplicates and hidden_background
--   (entries taken off the timeline), aliases (other names; they pick the evidence wording shown).
-- Everything else in meta (summary_version, images_version, images_seen, summary_check, editor_notes,
-- staff_text, staff_headlines, manual, superseded_by, ...) is bookkeeping and does not count.
CREATE OR REPLACE FUNCTION public.stamp_matter_content() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.content_updated_at := COALESCE(NEW.content_updated_at, now());
    RETURN NEW;
  END IF;
  IF NEW.content_updated_at IS DISTINCT FROM OLD.content_updated_at THEN
    RETURN NEW;
  END IF;
  IF (NEW.title, NEW.identifier, NEW.description, NEW.plain_english_summary, NEW.category, NEW.status,
      NEW.bylaw_id, NEW.merged_into)
     IS DISTINCT FROM
     (OLD.title, OLD.identifier, OLD.description, OLD.plain_english_summary, OLD.category, OLD.status,
      OLD.bylaw_id, OLD.merged_into)
     OR EXISTS (
       SELECT 1 FROM unnest(ARRAY['display_title', 'status_line', 'entry_lines', 'timeline_headlines', 'images',
                                  'hidden', 'hidden_duplicates', 'hidden_background', 'aliases']) AS k
       WHERE NEW.meta -> k IS DISTINCT FROM OLD.meta -> k) THEN
    NEW.content_updated_at := now();
  END IF;
  RETURN NEW;
END $$;

-- Named to fire after flatten_matter_merge (BEFORE triggers run in name order), so it sees the final merged_into.
DROP TRIGGER IF EXISTS stamp_matter_content ON public.matters;
CREATE TRIGGER stamp_matter_content BEFORE INSERT OR UPDATE ON public.matters
  FOR EACH ROW EXECUTE FUNCTION public.stamp_matter_content();

-- AFTER INSERT/UPDATE/DELETE on the tables that put entries on a topic page: bump the topic(s) on both
-- sides of the change. Hidden rows aren't shown, so adding or deleting one changes nothing; hiding or
-- unhiding one does. One UPDATE by primary key; the IS DISTINCT FROM now() guard makes a bulk statement
-- (moving 50 items into one topic) write each topic once per transaction. SECURITY DEFINER so a writer
-- allowed to change these rows never fails for lack of UPDATE on matters.
CREATE OR REPLACE FUNCTION public.bump_matter_content() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  ids bigint[] := '{}';
  old_shown boolean := TG_OP <> 'INSERT';
  new_shown boolean := TG_OP <> 'DELETE';
BEGIN
  -- agenda_items has no hidden column, and plpgsql can't be relied on to skip OLD.hidden inside one
  -- expression, so the hidden checks sit in their own branch.
  IF TG_TABLE_NAME <> 'agenda_items' THEN
    IF old_shown THEN old_shown := NOT OLD.hidden; END IF;
    IF new_shown THEN new_shown := NOT NEW.hidden; END IF;
  END IF;
  IF old_shown THEN ids := ids || OLD.matter_id; END IF;
  IF new_shown THEN ids := ids || NEW.matter_id; END IF;
  IF TG_TABLE_NAME = 'matter_links' THEN
    IF old_shown THEN ids := ids || OLD.related_matter_id; END IF;
    IF new_shown THEN ids := ids || NEW.related_matter_id; END IF;
  END IF;
  IF array_length(ids, 1) > 0 THEN
    UPDATE matters SET content_updated_at = now()
    WHERE id = ANY (ids) AND content_updated_at IS DISTINCT FROM now();
  END IF;
  RETURN NULL;
END $$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['agenda_items', 'matter_links', 'matter_evidence', 'matter_report_mentions'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS bump_matter_content_ins_del ON public.%I', t);
    EXECUTE format('DROP TRIGGER IF EXISTS bump_matter_content_upd ON public.%I', t);
    EXECUTE format('CREATE TRIGGER bump_matter_content_ins_del AFTER INSERT OR DELETE ON public.%I
                    FOR EACH ROW EXECUTE FUNCTION public.bump_matter_content()', t);
  END LOOP;
END $$;

-- Updates count only when they move an entry or change whether / what it shows.
CREATE TRIGGER bump_matter_content_upd AFTER UPDATE OF matter_id ON public.agenda_items
  FOR EACH ROW WHEN (OLD.matter_id IS DISTINCT FROM NEW.matter_id)
  EXECUTE FUNCTION public.bump_matter_content();
CREATE TRIGGER bump_matter_content_upd AFTER UPDATE ON public.matter_links
  FOR EACH ROW WHEN ((OLD.hidden, OLD.matter_id, OLD.related_matter_id, OLD.agenda_item_id, OLD.quote)
                     IS DISTINCT FROM (NEW.hidden, NEW.matter_id, NEW.related_matter_id, NEW.agenda_item_id, NEW.quote))
  EXECUTE FUNCTION public.bump_matter_content();
CREATE TRIGGER bump_matter_content_upd AFTER UPDATE ON public.matter_evidence
  FOR EACH ROW WHEN ((OLD.hidden, OLD.matter_id, OLD.agenda_item_id, OLD.document_section_id)
                     IS DISTINCT FROM (NEW.hidden, NEW.matter_id, NEW.agenda_item_id, NEW.document_section_id))
  EXECUTE FUNCTION public.bump_matter_content();
CREATE TRIGGER bump_matter_content_upd AFTER UPDATE ON public.matter_report_mentions
  FOR EACH ROW WHEN ((OLD.hidden, OLD.matter_id, OLD.report_id, OLD.page, OLD.quote)
                     IS DISTINCT FROM (NEW.hidden, NEW.matter_id, NEW.report_id, NEW.page, NEW.quote))
  EXECUTE FUNCTION public.bump_matter_content();

-- Trigger functions only run as triggers; nobody needs to call them.
REVOKE ALL ON FUNCTION public.stamp_matter_content() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.bump_matter_content() FROM PUBLIC, anon, authenticated;
