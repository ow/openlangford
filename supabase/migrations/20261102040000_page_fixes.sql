-- Marking a page "needs work" starts an agent fix on the server: the page is "fixing" while it runs, then "fixed"
-- (waiting for staff to confirm) with a note of what changed and what it couldn't do.
-- Admin-only table; the constraint is replaced in one statement: safe on live data.
ALTER TABLE page_reviews DROP CONSTRAINT IF EXISTS page_reviews_status_check,
  ADD CONSTRAINT page_reviews_status_check CHECK (status IN ('reviewed', 'needs_work', 'fixing', 'fixed'));
ALTER TABLE page_reviews ADD COLUMN IF NOT EXISTS agent_note text;
ALTER TABLE page_reviews ADD COLUMN IF NOT EXISTS agent_at timestamptz;
