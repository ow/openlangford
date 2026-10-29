-- Story links between matters, and mentions of a matter in mixed-topic agenda
-- items (notices of motion, presentations, public participation).
-- Written by pipeline/ingestion/matter_links.py; read by the matter page.
CREATE TABLE IF NOT EXISTS matter_links (
  id bigserial PRIMARY KEY,
  matter_id bigint NOT NULL REFERENCES matters(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('related_matter', 'mention')),
  related_matter_id bigint REFERENCES matters(id) ON DELETE CASCADE,
  agenda_item_id bigint REFERENCES agenda_items(id) ON DELETE CASCADE,
  confidence real,
  source text NOT NULL DEFAULT 'resolver',
  hidden boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (kind = 'related_matter' AND related_matter_id IS NOT NULL AND agenda_item_id IS NULL AND related_matter_id <> matter_id)
    OR (kind = 'mention' AND agenda_item_id IS NOT NULL AND related_matter_id IS NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS matter_links_related_uniq
  ON matter_links (LEAST(matter_id, related_matter_id), GREATEST(matter_id, related_matter_id))
  WHERE kind = 'related_matter';
CREATE UNIQUE INDEX IF NOT EXISTS matter_links_mention_uniq
  ON matter_links (matter_id, agenda_item_id) WHERE kind = 'mention';
CREATE INDEX IF NOT EXISTS matter_links_matter_idx ON matter_links (matter_id);
CREATE INDEX IF NOT EXISTS matter_links_related_idx ON matter_links (related_matter_id);

ALTER TABLE matter_links ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "matter_links public read" ON matter_links;
CREATE POLICY "matter_links public read" ON matter_links FOR SELECT TO anon, authenticated USING (NOT hidden);
