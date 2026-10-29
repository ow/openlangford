-- Properties (one civic address = one lot) and everything Council considered
-- about them: a rezoning, a later variance, a business licence appeal and a
-- letter about a fence are separate matters, but the same place.
-- Written by pipeline/ingestion/properties.py from agenda_items.related_address
-- and item / matter titles; read by /properties/:slug and the matter page.
CREATE TABLE IF NOT EXISTS properties (
  id bigserial PRIMARY KEY,
  municipality_id bigint NOT NULL DEFAULT 1,
  slug text NOT NULL UNIQUE,
  address text NOT NULL,           -- display form: "2750 Leigh Road"
  civic_number text NOT NULL,
  street text NOT NULL,            -- "Leigh Road"
  geo jsonb,                       -- {lat, lng} from geocoded agenda items
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS properties_street_idx ON properties (lower(street));

-- One row per agenda item that names the property (matter_id is the item's
-- canonical matter, if any), or per matter whose title names it (no item).
CREATE TABLE IF NOT EXISTS property_links (
  id bigserial PRIMARY KEY,
  property_id bigint NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  agenda_item_id bigint REFERENCES agenda_items(id) ON DELETE CASCADE,
  matter_id bigint REFERENCES matters(id) ON DELETE CASCADE,
  source text NOT NULL CHECK (source IN ('item_address', 'item_title', 'matter_title', 'admin')),
  hidden boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (agenda_item_id IS NOT NULL OR matter_id IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS property_links_item_uniq
  ON property_links (property_id, agenda_item_id) WHERE agenda_item_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS property_links_matter_uniq
  ON property_links (property_id, matter_id) WHERE agenda_item_id IS NULL;
CREATE INDEX IF NOT EXISTS property_links_matter_idx ON property_links (matter_id);
CREATE INDEX IF NOT EXISTS property_links_item_idx ON property_links (agenda_item_id);

ALTER TABLE properties ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "properties public read" ON properties;
CREATE POLICY "properties public read" ON properties FOR SELECT TO anon, authenticated USING (true);
ALTER TABLE property_links ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "property_links public read" ON property_links;
CREATE POLICY "property_links public read" ON property_links FOR SELECT TO anon, authenticated USING (NOT hidden);
