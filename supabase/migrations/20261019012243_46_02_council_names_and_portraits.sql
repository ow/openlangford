-- Public display names and verified portraits. Keep permanent person IDs and records intact.
-- Portrait provenance: apps/web/public/images/council/sources.json.
-- Wendy Hobbs, Jennifer Dunnett and Brandy Gordon deliberately have no sourced
-- portrait: available images were scenes or campaign graphics, not clear headshots.
BEGIN;
DO $$
DECLARE entry record;
BEGIN
  FOR entry IN SELECT * FROM (VALUES
    ('Scott Goodmanson', 'S. Goodmanson', '/images/council/scott-goodmanson.webp', 'https://langford.ca/city-hall/council-committees/mayor-council/'),
    ('Kimberley Guiry', 'K. Guiry', '/images/council/kimberley-guiry.webp', 'https://langford.ca/city-hall/council-committees/mayor-council/'),
    ('Colby Harder', 'C. Harder', '/images/council/colby-harder.webp', 'https://langford.ca/city-hall/council-committees/mayor-council/'),
    ('Mark Morley', 'M. Morley', '/images/council/mark-morley.webp', 'https://langford.ca/city-hall/council-committees/mayor-council/'),
    ('Lillian Szpak', 'L. Szpak', '/images/council/lillian-szpak.webp', 'https://langford.ca/city-hall/council-committees/mayor-council/'),
    ('Mary Wagner', 'M. Wagner', '/images/council/mary-wagner.webp', 'https://langford.ca/city-hall/council-committees/mayor-council/'),
    ('Keith Yacucha', 'K. Yacucha', '/images/council/keith-yacucha.webp', 'https://langford.ca/city-hall/council-committees/mayor-council/'),
    ('Stew Young', 'S. Young', '/images/council/stew-young.webp', 'https://stewyoung.com/'),
    ('Lisa Foxall', 'L. Foxall', '/images/council/lisa-foxall.webp', 'https://lisafoxall.ca/'),
    ('Wendy Hobbs', 'W. Hobbs', '', ''),
    ('Bryson Hill', 'B. Hill', '/images/council/bryson-hill.webp', 'https://brysonforlangford.ca/'),
    ('Jennifer Dunnett', 'J. Dunnett', '', ''),
    ('Brandy Gordon', 'B. Gordon', '', '')
  ) AS portraits(full_name, initial_name, image_path, source_page)
  LOOP
    IF (SELECT count(*) FROM people WHERE name IN (entry.full_name, entry.initial_name)) > 1 THEN
      RAISE EXCEPTION 'Multiple person IDs for %; reconcile before renaming', entry.full_name;
    END IF;
    UPDATE people p SET
      name = entry.full_name,
      image_url = CASE WHEN entry.image_path <> '' THEN entry.image_path ELSE p.image_url END,
      meta = coalesce(p.meta, '{}'::jsonb) || jsonb_build_object('display_name_source',
        'https://langford.ca/city-hall/council-committees/declared-candidates/') ||
        CASE WHEN entry.image_path <> '' THEN jsonb_build_object('portrait_source', entry.source_page,
          'portrait_verified_on', '2026-10-18') ELSE '{}'::jsonb END
    WHERE p.name IN (entry.full_name, entry.initial_name)
      AND EXISTS (SELECT 1 FROM memberships m JOIN organizations o ON o.id = m.organization_id
        WHERE m.person_id = p.id AND o.classification = 'Council' AND o.municipality_id = 1);
  END LOOP;
END $$;
COMMIT;
