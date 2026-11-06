-- A reader's check of a page by the model: the entries it flagged (with an admin's verdict on each, which
-- calibrates later checks) and any problem with the page as a whole. A page can be checked before anyone has
-- marked it reviewed, so status becomes optional. Columns added to an admin-only table: safe on live data.
ALTER TABLE page_reviews ALTER COLUMN status DROP NOT NULL;
ALTER TABLE page_reviews ADD COLUMN IF NOT EXISTS ai_flags jsonb;
ALTER TABLE page_reviews ADD COLUMN IF NOT EXISTS ai_page_issue text;
ALTER TABLE page_reviews ADD COLUMN IF NOT EXISTS ai_model text;
ALTER TABLE page_reviews ADD COLUMN IF NOT EXISTS ai_checked_at timestamptz;
ALTER TABLE page_reviews ALTER COLUMN reviewed_at DROP NOT NULL;
ALTER TABLE page_reviews ALTER COLUMN reviewed_at DROP DEFAULT;
CREATE INDEX IF NOT EXISTS page_reviews_checked ON page_reviews (ai_checked_at DESC) WHERE ai_checked_at IS NOT NULL;
