-- Undo 20261102220000: an agreed suggestion is review 'accepted' while still hidden (the fix agent publishes it on
-- the next Fix), the same as an agreed flag that isn't fixed yet. No rows use 'agreed'.
ALTER TABLE matter_links DROP CONSTRAINT IF EXISTS matter_links_review_check;
ALTER TABLE matter_links ADD CONSTRAINT matter_links_review_check
  CHECK (review = ANY (ARRAY['removed'::text, 'accepted'::text, 'rejected'::text]));
ALTER TABLE matter_report_mentions DROP CONSTRAINT IF EXISTS matter_report_mentions_review_check;
ALTER TABLE matter_report_mentions ADD CONSTRAINT matter_report_mentions_review_check
  CHECK (review = ANY (ARRAY['removed'::text, 'accepted'::text, 'rejected'::text]));
