-- Old meeting slugs keep resolving (301 to the current slug) after a meeting's slug is renamed,
-- e.g. when its date is corrected (research/meeting-dates). Additive only.
CREATE TABLE IF NOT EXISTS meeting_slug_history (
  id              bigserial PRIMARY KEY,
  meeting_id      bigint NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  municipality_id bigint NOT NULL REFERENCES municipalities(id),
  old_slug        text   NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
-- Same uniqueness scope as meetings.slug (idx_meetings_slug_muni).
CREATE UNIQUE INDEX IF NOT EXISTS idx_meeting_slug_history_slug_muni ON meeting_slug_history (old_slug, municipality_id);
CREATE INDEX IF NOT EXISTS idx_meeting_slug_history_meeting ON meeting_slug_history (meeting_id);

ALTER TABLE meeting_slug_history ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "meeting_slug_history public read" ON meeting_slug_history;
CREATE POLICY "meeting_slug_history public read" ON meeting_slug_history FOR SELECT TO anon, authenticated USING (true);
