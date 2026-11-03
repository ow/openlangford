-- Supporting records (matter_evidence: a page of a report or budget that names a topic) get the same staff decision
-- as other timeline links: an entry removed from a page is hidden with who removed it and when, not deleted, so it
-- can be restored and is never shown again. Columns added with defaults: safe on live data.
ALTER TABLE matter_evidence ADD COLUMN IF NOT EXISTS hidden boolean NOT NULL DEFAULT false;
ALTER TABLE matter_evidence ADD COLUMN IF NOT EXISTS review text CHECK (review IN ('removed'));
ALTER TABLE matter_evidence ADD COLUMN IF NOT EXISTS reviewed_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE matter_evidence ADD COLUMN IF NOT EXISTS reviewed_at timestamptz;
-- Public reads skip removed links, as they do for annual report mentions.
DROP POLICY IF EXISTS "Allow public read-only access on matter_evidence" ON matter_evidence;
CREATE POLICY "Allow public read-only access on matter_evidence" ON matter_evidence FOR SELECT TO public USING (NOT hidden);
