-- An address merged into another (properties.meta.merged_into: a misspelling such as "245 Atkins Road" for
-- "245 Atkins Avenue") is an alias: it keeps its row so its old page redirects and the properties stage maps its
-- mentions onto the address it was merged into, but it has no page of its own and is never listed. The privacy
-- refresh owns properties.hidden, so it has to keep aliases hidden too.
CREATE OR REPLACE FUNCTION public.property_privacy_flags() RETURNS TABLE(id bigint, hide boolean)
    LANGUAGE sql STABLE
    SET search_path TO 'public', 'pg_temp'
    AS $$
  SELECT p.id,
    (p.meta ? 'merged_into')
    OR (p.civic_number <> ''
    AND NOT EXISTS (
      SELECT 1 FROM property_links l
      LEFT JOIN agenda_items ai ON ai.id = l.agenda_item_id
      LEFT JOIN matters m ON m.id = l.matter_id
      WHERE l.property_id = p.id AND NOT l.hidden
        AND (l.matter_id IS NULL OR (m.merged_into IS NULL AND coalesce(m.meta->>'hidden', 'false') <> 'true'))
        AND (l.agenda_item_id IS NULL OR NOT is_public_input_item(ai.title, ai.category)))
    AND EXISTS (
      SELECT 1 FROM property_links l JOIN agenda_items ai ON ai.id = l.agenda_item_id
      WHERE l.property_id = p.id AND is_public_input_item(ai.title, ai.category)))
  FROM properties p
$$;
REVOKE ALL ON FUNCTION public.property_privacy_flags() FROM PUBLIC;
GRANT ALL ON FUNCTION public.property_privacy_flags() TO service_role;
