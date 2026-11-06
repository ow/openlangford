-- Residents' home addresses are not published.
-- A lot that Council business never named, known only because a resident gave it as their home
-- address while speaking or writing to Council (public participation, delegations, letters,
-- petitions), had a public page with its house number (noindexed only). Such lots are now hidden:
-- no page (404), and left out of street pages, maps, the /properties index, search and sitemaps.
-- The rows stay (private) so the pipeline keeps matching the same address to the same lot.
--
-- properties.hidden is computed by refresh_property_privacy(), which the pipeline's properties stage
-- calls after every rebuild. New rows start hidden until that runs, so a resident's address is never
-- public in between. Street rows (no house number) are never hidden.
-- Changes only the new flag (reversible: UPDATE properties SET hidden = false); logs counts only.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- Same rule as apps/web/app/lib/public-input.ts and the pipeline's property_summaries.is_public_input.
CREATE OR REPLACE FUNCTION public.is_public_input_item(p_title text, p_category text)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT lower(btrim(coalesce(p_category, ''))) = 'public input'
    OR coalesce(p_title, '') ~* 'public\s+(participation|input|comment|hearing\s+submission)|correspondence|delegation|written\s+submission|petition'
$$;

ALTER TABLE public.properties ADD COLUMN IF NOT EXISTS hidden boolean NOT NULL DEFAULT true;

-- A lot is hidden when public input names it and nothing else shown on the site does: no visible
-- link to a non-public-input agenda item, or to a visible matter by its title.
CREATE OR REPLACE FUNCTION public.property_privacy_flags()
RETURNS TABLE(id bigint, hide boolean) LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT p.id,
    p.civic_number <> ''
    AND NOT EXISTS (
      SELECT 1 FROM property_links l
      LEFT JOIN agenda_items ai ON ai.id = l.agenda_item_id
      LEFT JOIN matters m ON m.id = l.matter_id
      WHERE l.property_id = p.id AND NOT l.hidden
        AND (l.matter_id IS NULL OR (coalesce(m.meta->>'canonical_matter_id', '') = '' AND coalesce(m.meta->>'hidden', 'false') <> 'true'))
        AND (l.agenda_item_id IS NULL OR NOT is_public_input_item(ai.title, ai.category)))
    AND EXISTS (
      SELECT 1 FROM property_links l JOIN agenda_items ai ON ai.id = l.agenda_item_id
      WHERE l.property_id = p.id AND is_public_input_item(ai.title, ai.category))
  FROM properties p
$$;
REVOKE ALL ON FUNCTION public.property_privacy_flags() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.property_privacy_flags() TO service_role;

-- Applies property_privacy_flags (or, on a dry run, only counts). Returns counts only.
CREATE OR REPLACE FUNCTION public.refresh_property_privacy(p_dry_run boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE hidden_now integer; changed integer;
BEGIN
  IF p_dry_run THEN
    SELECT count(*) FILTER (WHERE f.hide), count(*) FILTER (WHERE p.hidden IS DISTINCT FROM f.hide)
      INTO hidden_now, changed FROM property_privacy_flags() f JOIN properties p ON p.id = f.id;
  ELSE
    UPDATE properties p SET hidden = f.hide FROM property_privacy_flags() f
    WHERE f.id = p.id AND p.hidden IS DISTINCT FROM f.hide;
    GET DIAGNOSTICS changed = ROW_COUNT;
    SELECT count(*) INTO hidden_now FROM properties WHERE hidden;
  END IF;
  RETURN jsonb_build_object('dry_run', p_dry_run, 'hidden', hidden_now, 'changed', changed);
END $$;
REVOKE ALL ON FUNCTION public.refresh_property_privacy(boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_property_privacy(boolean) TO service_role;

DO $$
DECLARE summary jsonb := public.refresh_property_privacy(false);
BEGIN
  RAISE NOTICE 'Resident-only lots hidden: % (of % lots)', summary->>'hidden', (SELECT count(*) FROM public.properties WHERE civic_number <> '');
END $$;

-- The public key reads only visible lots and their links. Writes were already blocked by RLS (no
-- write policies); drop the leftover grants too.
DROP POLICY IF EXISTS "properties public read" ON public.properties;
CREATE POLICY "properties public read" ON public.properties FOR SELECT TO anon, authenticated USING (NOT hidden);
DROP POLICY IF EXISTS "property_links public read" ON public.property_links;
CREATE POLICY "property_links public read" ON public.property_links FOR SELECT TO anon, authenticated
  USING (NOT hidden AND EXISTS (SELECT 1 FROM public.properties p WHERE p.id = property_id AND NOT p.hidden));
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, TRIGGER, REFERENCES ON public.properties, public.property_links FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.properties, public.property_links TO anon, authenticated;

CREATE INDEX IF NOT EXISTS properties_visible_idx ON public.properties (id) WHERE NOT hidden;

COMMIT;
