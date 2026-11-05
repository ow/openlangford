-- Pages queued for a check ahead of review (the reviews page's "Pre-check"): the five-minute cron checks them a few
-- at a time and clears the mark. page_reviews stays staff-only (RLS on, no grants to anon/authenticated).
ALTER TABLE page_reviews ADD COLUMN IF NOT EXISTS check_requested_at timestamptz;
CREATE INDEX IF NOT EXISTS page_reviews_check_queue ON page_reviews (check_requested_at) WHERE check_requested_at IS NOT NULL;
