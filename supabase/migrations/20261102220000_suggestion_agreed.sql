-- A search suggestion staff agreed to (👍 in the review bar) but that isn't on the page yet: the fix agent adds it on
-- the next Fix, with the rest of the page's fixes and one summary rewrite. Still hidden until then.
ALTER TABLE matter_links DROP CONSTRAINT IF EXISTS matter_links_review_check;
ALTER TABLE matter_links ADD CONSTRAINT matter_links_review_check
  CHECK (review = ANY (ARRAY['removed'::text, 'accepted'::text, 'rejected'::text, 'agreed'::text]));
ALTER TABLE matter_report_mentions DROP CONSTRAINT IF EXISTS matter_report_mentions_review_check;
ALTER TABLE matter_report_mentions ADD CONSTRAINT matter_report_mentions_review_check
  CHECK (review = ANY (ARRAY['removed'::text, 'accepted'::text, 'rejected'::text, 'agreed'::text]));
