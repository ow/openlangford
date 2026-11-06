-- Migration: public_url_slugs
-- Public URLs use human slugs instead of numeric ids (people already do).
--
--   * matters: regenerate the id-prefixed, mid-word-truncated slugs
--     ("1665-solid-waste-collection-bylaw-no-2299-2026-first-se") from
--     meta->>'display_title' (else the title minus stage parentheticals),
--     capped at a word boundary and de-duplicated with -2/-3.
--     Only rows still carrying the old "{id}-..." format are touched, so the
--     migration is idempotent and slugs stay stable once generated.
--   * bylaws: "bylaw-{number}" (or title) with -2/-3 de-duplication, never
--     all-digit (an all-digit param is treated as a legacy id by the web app).
--   * elections: new slug column from the name, backfilled, unique, trigger.
--   * meetings: already unique "{date}-{type}" slugs + trigger; unchanged.
--
-- Safe to re-run.

BEGIN;

-- -----------------------------------------------------------------------------
-- Helpers
-- -----------------------------------------------------------------------------

-- Slug capped at a word (hyphen) boundary rather than mid-word.
CREATE OR REPLACE FUNCTION public.generate_slug_capped(input text, max_len int DEFAULT 60)
RETURNS text LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE
  full_slug text := public.generate_slug(input, 1000);
  capped text;
BEGIN
  IF length(full_slug) <= max_len THEN RETURN full_slug; END IF;
  capped := left(full_slug, max_len);
  -- Cut mid-word: drop the partial trailing word (unless it is the only word).
  IF substr(full_slug, max_len + 1, 1) <> '-' AND position('-' IN capped) > 0 THEN
    capped := regexp_replace(capped, '-[^-]*$', '');
  END IF;
  -- Don't end a truncated slug on a dangling connective ("...-and").
  capped := regexp_replace(capped, '(-(and|or|of|the|to|for|a|an|in|on|at|with|by|from|&))+$', '');
  RETURN trim(BOTH '-' FROM capped);
END;
$$;

-- Base (un-deduplicated) matter slug.
CREATE OR REPLACE FUNCTION public.matter_slug_base(title text, meta jsonb)
RETURNS text LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  src text := nullif(trim(meta->>'display_title'), '');
  base text;
BEGIN
  IF src IS NULL THEN
    src := COALESCE(title, '');
    -- Stage / procedural parentheticals: "(FIRST, SECOND AND THIRD READINGS)",
    -- "(ADOPTION)", "(Background report attached)", ...
    src := regexp_replace(
      src,
      '\s*\(\s*(first|second|third|final|1st|2nd|3rd|three|adoption|adopt|reading|readings|background|staff report|report attached|rescind|reconsideration)[^)]*\)',
      '', 'gi');
    -- Trailing stage suffixes: "... - Adoption", "... — First Reading"
    src := regexp_replace(
      src,
      '\s*[-–—:]\s*(adoption|readings?|(first|second|third|final)( (and|&|,) ?(second|third))*( and third)? readings?)\s*$',
      '', 'gi');
  END IF;
  base := public.generate_slug_capped(src, 60);
  IF base IS NULL OR base = '' THEN base := 'matter'; END IF;
  -- Never all digits: the web app treats all-digit params as legacy ids.
  IF base ~ '^[0-9]+$' THEN base := 'matter-' || base; END IF;
  RETURN base;
END;
$$;

-- -----------------------------------------------------------------------------
-- Matters: regenerate old-format "{id}-..." slugs
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  r record;
  base text;
  candidate text;
  n int;
BEGIN
  CREATE TEMP TABLE _matter_reslug ON COMMIT DROP AS
    SELECT id FROM matters WHERE slug LIKE id::text || '-%' OR slug = id::text;

  -- Clear first so old slugs can't collide with new ones mid-loop.
  UPDATE matters SET slug = 'tmp-reslug-' || id WHERE id IN (SELECT id FROM _matter_reslug);

  FOR r IN
    SELECT m.id, m.title, m.meta, m.municipality_id
    FROM matters m JOIN _matter_reslug t ON t.id = m.id
    ORDER BY m.id
  LOOP
    base := public.matter_slug_base(r.title, r.meta);
    candidate := base;
    n := 1;
    WHILE EXISTS (
      SELECT 1 FROM matters
      WHERE slug = candidate AND municipality_id IS NOT DISTINCT FROM r.municipality_id AND id <> r.id
    ) LOOP
      n := n + 1;
      candidate := base || '-' || n;
    END LOOP;
    UPDATE matters SET slug = candidate WHERE id = r.id;
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION public.trigger_matter_slug()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  base text;
  candidate text;
  n int := 1;
BEGIN
  IF NEW.slug IS NOT NULL THEN RETURN NEW; END IF;
  base := public.matter_slug_base(NEW.title, NEW.meta);
  candidate := base;
  WHILE EXISTS (
    SELECT 1 FROM matters WHERE slug = candidate AND municipality_id IS NOT DISTINCT FROM NEW.municipality_id
  ) LOOP
    n := n + 1;
    candidate := base || '-' || n;
  END LOOP;
  NEW.slug := candidate;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_matter_slug ON matters;
CREATE TRIGGER trg_matter_slug BEFORE INSERT ON matters
  FOR EACH ROW EXECUTE FUNCTION public.trigger_matter_slug();

CREATE UNIQUE INDEX IF NOT EXISTS idx_matters_slug_muni ON matters(slug, municipality_id);

-- -----------------------------------------------------------------------------
-- Meetings: slugs + trigger + unique index already exist; ensure the index.
-- -----------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS idx_meetings_slug_muni ON meetings(slug, municipality_id);

-- -----------------------------------------------------------------------------
-- Bylaws
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.bylaw_slug_base(bylaw_number text, title text)
RETURNS text LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  base text;
BEGIN
  IF nullif(trim(bylaw_number), '') IS NOT NULL THEN
    base := public.generate_slug_capped('bylaw ' || regexp_replace(bylaw_number, '^\s*bylaw\s*(no\.?)?\s*', '', 'i'), 60);
  ELSE
    base := public.generate_slug_capped(COALESCE(title, 'bylaw'), 60);
  END IF;
  IF base IS NULL OR base = '' THEN base := 'bylaw'; END IF;
  IF base ~ '^[0-9]+$' THEN base := 'bylaw-' || base; END IF;
  RETURN base;
END;
$$;

CREATE OR REPLACE FUNCTION public.trigger_bylaw_slug()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  base text;
  candidate text;
  n int := 1;
BEGIN
  IF NEW.slug IS NOT NULL THEN RETURN NEW; END IF;
  base := public.bylaw_slug_base(NEW.bylaw_number, NEW.title);
  candidate := base;
  WHILE EXISTS (
    SELECT 1 FROM bylaws WHERE slug = candidate AND municipality_id IS NOT DISTINCT FROM NEW.municipality_id
  ) LOOP
    n := n + 1;
    candidate := base || '-' || n;
  END LOOP;
  NEW.slug := candidate;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_bylaw_slug ON bylaws;
CREATE TRIGGER trg_bylaw_slug BEFORE INSERT ON bylaws
  FOR EACH ROW EXECUTE FUNCTION public.trigger_bylaw_slug();

-- Rewrite old-format bylaw slugs ("{number}-{id}" / "{id}-{title}"); table
-- is empty in production today, so this is normally a no-op.
DO $$
DECLARE
  r record;
  base text;
  candidate text;
  n int;
BEGIN
  CREATE TEMP TABLE _bylaw_reslug ON COMMIT DROP AS
    SELECT id FROM bylaws
    WHERE slug LIKE id::text || '-%' OR slug LIKE '%-' || id::text OR slug ~ '^[0-9]+$';
  UPDATE bylaws SET slug = 'tmp-reslug-' || id WHERE id IN (SELECT id FROM _bylaw_reslug);
  FOR r IN
    SELECT b.id, b.bylaw_number, b.title, b.municipality_id
    FROM bylaws b JOIN _bylaw_reslug t ON t.id = b.id ORDER BY b.id
  LOOP
    base := public.bylaw_slug_base(r.bylaw_number, r.title);
    candidate := base;
    n := 1;
    WHILE EXISTS (
      SELECT 1 FROM bylaws
      WHERE slug = candidate AND municipality_id IS NOT DISTINCT FROM r.municipality_id AND id <> r.id
    ) LOOP
      n := n + 1;
      candidate := base || '-' || n;
    END LOOP;
    UPDATE bylaws SET slug = candidate WHERE id = r.id;
  END LOOP;
END;
$$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_bylaws_slug_muni ON bylaws(slug, municipality_id);

-- -----------------------------------------------------------------------------
-- Elections
-- -----------------------------------------------------------------------------
ALTER TABLE elections ADD COLUMN IF NOT EXISTS slug text;

CREATE OR REPLACE FUNCTION public.election_slug_base(name text, election_date date)
RETURNS text LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  base text := public.generate_slug_capped(COALESCE(nullif(trim(name), ''), election_date::text || ' election'), 60);
BEGIN
  IF base IS NULL OR base = '' THEN base := 'election'; END IF;
  IF base ~ '^[0-9]+$' THEN base := base || '-election'; END IF;
  RETURN base;
END;
$$;

DO $$
DECLARE
  r record;
  base text;
  candidate text;
  n int;
BEGIN
  FOR r IN SELECT id, name, election_date FROM elections WHERE slug IS NULL ORDER BY id LOOP
    base := public.election_slug_base(r.name, r.election_date);
    candidate := base;
    n := 1;
    WHILE EXISTS (SELECT 1 FROM elections WHERE slug = candidate AND id <> r.id) LOOP
      n := n + 1;
      candidate := base || '-' || n;
    END LOOP;
    UPDATE elections SET slug = candidate WHERE id = r.id;
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION public.trigger_election_slug()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  base text;
  candidate text;
  n int := 1;
BEGIN
  IF NEW.slug IS NOT NULL THEN RETURN NEW; END IF;
  base := public.election_slug_base(NEW.name, NEW.election_date);
  candidate := base;
  WHILE EXISTS (SELECT 1 FROM elections WHERE slug = candidate) LOOP
    n := n + 1;
    candidate := base || '-' || n;
  END LOOP;
  NEW.slug := candidate;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_election_slug ON elections;
CREATE TRIGGER trg_election_slug BEFORE INSERT ON elections
  FOR EACH ROW EXECUTE FUNCTION public.trigger_election_slug();

CREATE UNIQUE INDEX IF NOT EXISTS idx_elections_slug ON elections(slug);
ALTER TABLE elections ALTER COLUMN slug SET NOT NULL;

COMMIT;
