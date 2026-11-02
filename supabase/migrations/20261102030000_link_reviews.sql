-- Staff decisions on timeline links, from the page review bar: an entry removed from a page, and suggestions
-- (links a "find missing" search wrote hidden, suggested_at set) accepted or rejected. A decided link is never
-- re-added, re-checked or deleted by the pipeline, and recent decisions are examples for its next judgments.
-- Columns added to existing tables: safe on live data.
ALTER TABLE matter_links ADD COLUMN IF NOT EXISTS suggested_at timestamptz;
ALTER TABLE matter_links ADD COLUMN IF NOT EXISTS review text CHECK (review IN ('removed', 'accepted', 'rejected'));
ALTER TABLE matter_links ADD COLUMN IF NOT EXISTS reviewed_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE matter_links ADD COLUMN IF NOT EXISTS reviewed_at timestamptz;
ALTER TABLE matter_report_mentions ADD COLUMN IF NOT EXISTS suggested_at timestamptz;
ALTER TABLE matter_report_mentions ADD COLUMN IF NOT EXISTS review text CHECK (review IN ('removed', 'accepted', 'rejected'));
ALTER TABLE matter_report_mentions ADD COLUMN IF NOT EXISTS reviewed_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE matter_report_mentions ADD COLUMN IF NOT EXISTS reviewed_at timestamptz;
CREATE INDEX IF NOT EXISTS matter_links_suggested ON matter_links (matter_id) WHERE suggested_at IS NOT NULL AND review IS NULL;
CREATE INDEX IF NOT EXISTS matter_links_reviewed ON matter_links (reviewed_at DESC) WHERE review IS NOT NULL;
