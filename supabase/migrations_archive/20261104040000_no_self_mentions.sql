-- A topic never "mentions" an agenda item filed under it: the item is already one of its own entries.
-- These links were left behind when an item moved into a topic that had mentioned it (a staff refile, the page-fix
-- agent filing an entry here, the resolver). Clear the 115 that exist, drop a mention when its item is filed under
-- the same topic, and skip creating one. (Rows backed up before this migration.)

DELETE FROM public.matter_links l
USING public.agenda_items a
WHERE l.kind = 'mention' AND a.id = l.agenda_item_id AND a.matter_id = l.matter_id;

CREATE OR REPLACE FUNCTION public.drop_own_mention() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.matter_id IS NOT NULL THEN
    DELETE FROM matter_links WHERE kind = 'mention' AND matter_id = NEW.matter_id AND agenda_item_id = NEW.id;
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS drop_own_mention ON public.agenda_items;
CREATE TRIGGER drop_own_mention AFTER INSERT OR UPDATE OF matter_id ON public.agenda_items
  FOR EACH ROW WHEN (NEW.matter_id IS NOT NULL) EXECUTE FUNCTION public.drop_own_mention();

-- Runs after redirect_merged_matter (triggers fire in name order), so it sees the topic the link really lands on.
CREATE OR REPLACE FUNCTION public.skip_own_mention() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.kind = 'mention' AND EXISTS (SELECT 1 FROM agenda_items WHERE id = NEW.agenda_item_id AND matter_id = NEW.matter_id) THEN
    RETURN NULL;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS skip_own_mention ON public.matter_links;
CREATE TRIGGER skip_own_mention BEFORE INSERT OR UPDATE OF matter_id, agenda_item_id ON public.matter_links
  FOR EACH ROW EXECUTE FUNCTION public.skip_own_mention();
