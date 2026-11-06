-- Migration: complete_slug_backfill
-- add_slug_columns.sql was only partially applied to the Langford database:
-- the slug columns (and some unique indexes) exist, but no rows were
-- populated outside agenda_items, and generate_slug() + the BEFORE INSERT
-- triggers were never created.
--
-- This finishes the job idempotently: it only fills NULL slugs (existing
-- agenda_items slugs are left untouched), then adds the missing function,
-- triggers, unique indexes and NOT NULL constraints. Safe to re-run.

BEGIN;

-- -----------------------------------------------------------------------------
-- Helper (same definition as add_slug_columns.sql)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.generate_slug(input text, max_len int DEFAULT 60)
RETURNS text LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT left(
    trim(BOTH '-' FROM lower(regexp_replace(trim(input), '[^a-zA-Z0-9]+', '-', 'g'))),
    max_len
  );
$$;

-- -----------------------------------------------------------------------------
-- Backfill NULL slugs
-- -----------------------------------------------------------------------------

-- People: name slug, numeric suffix for duplicate names (ordered by id)
WITH ranked AS (
  SELECT id,
    public.generate_slug(name) AS base_slug,
    ROW_NUMBER() OVER (PARTITION BY public.generate_slug(name) ORDER BY id) AS rn
  FROM people
)
UPDATE people SET slug = CASE
  WHEN ranked.rn = 1 THEN ranked.base_slug
  ELSE ranked.base_slug || '-' || ranked.rn
END
FROM ranked
WHERE people.id = ranked.id AND people.slug IS NULL;

-- Meetings: {date}-{type}, suffix for duplicate date+type within a municipality
WITH ranked AS (
  SELECT id,
    meeting_date::text || '-' || public.generate_slug(type::text) AS base_slug,
    ROW_NUMBER() OVER (PARTITION BY municipality_id, meeting_date, type ORDER BY id) AS rn
  FROM meetings
)
UPDATE meetings SET slug = CASE
  WHEN ranked.rn = 1 THEN ranked.base_slug
  ELSE ranked.base_slug || '-' || ranked.rn
END
FROM ranked
WHERE meetings.id = ranked.id AND meetings.slug IS NULL;

-- Matters: id-prefixed, so always unique
UPDATE matters
SET slug = rtrim(id::text || '-' || public.generate_slug(title, 50), '-')
WHERE slug IS NULL;

-- Motions: m-{id}
UPDATE motions SET slug = 'm-' || id::text WHERE slug IS NULL;

-- Bylaws: bylaw_number, else id-title (table may be empty)
UPDATE bylaws
SET slug = CASE
  WHEN bylaw_number IS NOT NULL THEN public.generate_slug(bylaw_number) || '-' || id
  ELSE rtrim(id::text || '-' || public.generate_slug(COALESCE(title, 'bylaw'), 50), '-')
END
WHERE slug IS NULL;

-- -----------------------------------------------------------------------------
-- Unique indexes (scoped ones already exist on meetings/matters/bylaws)
-- -----------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS idx_people_slug ON people(slug);
CREATE UNIQUE INDEX IF NOT EXISTS idx_motions_slug ON motions(slug);
CREATE UNIQUE INDEX IF NOT EXISTS idx_agenda_items_slug ON agenda_items(slug);
CREATE UNIQUE INDEX IF NOT EXISTS idx_meetings_slug_muni ON meetings(slug, municipality_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_matters_slug_muni ON matters(slug, municipality_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_bylaws_slug_muni ON bylaws(slug, municipality_id);

-- -----------------------------------------------------------------------------
-- BEFORE INSERT triggers so new rows get slugs automatically
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.trigger_person_slug()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  base_slug text;
  candidate text;
  suffix int := 1;
BEGIN
  IF NEW.slug IS NOT NULL THEN RETURN NEW; END IF;
  base_slug := public.generate_slug(NEW.name);
  candidate := base_slug;
  WHILE EXISTS (SELECT 1 FROM people WHERE slug = candidate) LOOP
    suffix := suffix + 1;
    candidate := base_slug || '-' || suffix;
  END LOOP;
  NEW.slug := candidate;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_person_slug ON people;
CREATE TRIGGER trg_person_slug BEFORE INSERT ON people
  FOR EACH ROW EXECUTE FUNCTION public.trigger_person_slug();

CREATE OR REPLACE FUNCTION public.trigger_meeting_slug()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  base_slug text;
  candidate text;
  suffix int := 1;
BEGIN
  IF NEW.slug IS NOT NULL THEN RETURN NEW; END IF;
  base_slug := NEW.meeting_date::text || '-' || public.generate_slug(NEW.type::text);
  candidate := base_slug;
  WHILE EXISTS (
    SELECT 1 FROM meetings WHERE slug = candidate AND municipality_id = NEW.municipality_id
  ) LOOP
    suffix := suffix + 1;
    candidate := base_slug || '-' || suffix;
  END LOOP;
  NEW.slug := candidate;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_meeting_slug ON meetings;
CREATE TRIGGER trg_meeting_slug BEFORE INSERT ON meetings
  FOR EACH ROW EXECUTE FUNCTION public.trigger_meeting_slug();

CREATE OR REPLACE FUNCTION public.trigger_matter_slug()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.slug IS NOT NULL THEN RETURN NEW; END IF;
  NEW.slug := rtrim(NEW.id::text || '-' || public.generate_slug(NEW.title, 50), '-');
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_matter_slug ON matters;
CREATE TRIGGER trg_matter_slug BEFORE INSERT ON matters
  FOR EACH ROW EXECUTE FUNCTION public.trigger_matter_slug();

CREATE OR REPLACE FUNCTION public.trigger_motion_slug()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.slug IS NOT NULL THEN RETURN NEW; END IF;
  NEW.slug := 'm-' || NEW.id::text;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_motion_slug ON motions;
CREATE TRIGGER trg_motion_slug BEFORE INSERT ON motions
  FOR EACH ROW EXECUTE FUNCTION public.trigger_motion_slug();

CREATE OR REPLACE FUNCTION public.trigger_bylaw_slug()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.slug IS NOT NULL THEN RETURN NEW; END IF;
  IF NEW.bylaw_number IS NOT NULL THEN
    NEW.slug := public.generate_slug(NEW.bylaw_number);
    IF EXISTS (
      SELECT 1 FROM bylaws WHERE slug = NEW.slug AND municipality_id = NEW.municipality_id
    ) THEN
      NEW.slug := NEW.slug || '-' || NEW.id;
    END IF;
  ELSE
    NEW.slug := rtrim(NEW.id::text || '-' || public.generate_slug(COALESCE(NEW.title, 'bylaw'), 50), '-');
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_bylaw_slug ON bylaws;
CREATE TRIGGER trg_bylaw_slug BEFORE INSERT ON bylaws
  FOR EACH ROW EXECUTE FUNCTION public.trigger_bylaw_slug();

CREATE OR REPLACE FUNCTION public.trigger_agenda_item_slug()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.slug IS NOT NULL THEN RETURN NEW; END IF;
  NEW.slug := NEW.meeting_id::text || '-' || COALESCE(NEW.item_order, NEW.id::text) || '-' || left(public.generate_slug(COALESCE(NEW.title, 'item'), 40), 40);
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_agenda_item_slug ON agenda_items;
CREATE TRIGGER trg_agenda_item_slug BEFORE INSERT ON agenda_items
  FOR EACH ROW EXECUTE FUNCTION public.trigger_agenda_item_slug();

-- -----------------------------------------------------------------------------
-- NOT NULL (triggers guarantee future inserts satisfy it)
-- -----------------------------------------------------------------------------
ALTER TABLE people ALTER COLUMN slug SET NOT NULL;
ALTER TABLE meetings ALTER COLUMN slug SET NOT NULL;
ALTER TABLE matters ALTER COLUMN slug SET NOT NULL;
ALTER TABLE motions ALTER COLUMN slug SET NOT NULL;
ALTER TABLE bylaws ALTER COLUMN slug SET NOT NULL;
ALTER TABLE agenda_items ALTER COLUMN slug SET NOT NULL;

COMMIT;
