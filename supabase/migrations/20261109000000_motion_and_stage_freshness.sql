-- Two more things a reader sees on a topic page now bump matters.content_updated_at:
--   * a motion on one of its entries (the decision line and the Adopted badge), added, changed or removed. Before
--     this, a motion the fix agent added from the minutes changed the page without moving its freshness stamp.
--   * an entry's hand-set stage (agenda_items.meta.staff_stage, set by the fix agent's set_stage), which replaces the
--     stage guessed from the entry's wording.
-- Both stamp the topic the item is filed on and every topic showing it as a mention (shown matter_links rows).

CREATE OR REPLACE FUNCTION public.bump_matter_content_for_items(item_ids bigint[]) RETURNS void
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  UPDATE matters SET content_updated_at = now()
  WHERE content_updated_at IS DISTINCT FROM now()
    AND id IN (
      SELECT matter_id FROM agenda_items WHERE id = ANY (item_ids) AND matter_id IS NOT NULL
      UNION
      SELECT matter_id FROM matter_links WHERE agenda_item_id = ANY (item_ids) AND NOT hidden AND matter_id IS NOT NULL);
$$;

CREATE OR REPLACE FUNCTION public.bump_matter_content_motion() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  PERFORM bump_matter_content_for_items(ARRAY[
    CASE WHEN TG_OP <> 'INSERT' THEN OLD.agenda_item_id END,
    CASE WHEN TG_OP <> 'DELETE' THEN NEW.agenda_item_id END]);
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION public.bump_matter_content_stage() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  PERFORM bump_matter_content_for_items(ARRAY[NEW.id]);
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS bump_matter_content_ins_del ON public.motions;
CREATE TRIGGER bump_matter_content_ins_del AFTER INSERT OR DELETE ON public.motions
  FOR EACH ROW EXECUTE FUNCTION public.bump_matter_content_motion();
DROP TRIGGER IF EXISTS bump_matter_content_upd ON public.motions;
CREATE TRIGGER bump_matter_content_upd AFTER UPDATE ON public.motions
  FOR EACH ROW WHEN ((OLD.agenda_item_id, OLD.text_content, OLD.plain_english_summary, OLD.result, OLD.disposition)
                     IS DISTINCT FROM (NEW.agenda_item_id, NEW.text_content, NEW.plain_english_summary, NEW.result, NEW.disposition))
  EXECUTE FUNCTION public.bump_matter_content_motion();

DROP TRIGGER IF EXISTS bump_matter_content_stage ON public.agenda_items;
CREATE TRIGGER bump_matter_content_stage AFTER UPDATE OF meta ON public.agenda_items
  FOR EACH ROW WHEN (OLD.meta -> 'staff_stage' IS DISTINCT FROM NEW.meta -> 'staff_stage')
  EXECUTE FUNCTION public.bump_matter_content_stage();

-- Trigger functions only run as triggers; nobody needs to call them.
REVOKE ALL ON FUNCTION public.bump_matter_content_for_items(bigint[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.bump_matter_content_motion() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.bump_matter_content_stage() FROM PUBLIC, anon, authenticated;
