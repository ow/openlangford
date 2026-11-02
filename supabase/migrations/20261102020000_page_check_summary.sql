-- What a page check read and its overall assessment, so a clean result says what was looked at.
-- Columns added to an admin-only table: safe on live data.
ALTER TABLE page_reviews ADD COLUMN IF NOT EXISTS ai_summary text;
ALTER TABLE page_reviews ADD COLUMN IF NOT EXISTS ai_entries integer;
