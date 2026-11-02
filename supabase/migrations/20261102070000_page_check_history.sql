-- Flags staff rated on earlier checks of a page, kept when the page is checked again: they keep teaching later
-- checks (calibration examples) instead of being overwritten. Column on an admin-only table: safe on live data.
ALTER TABLE page_reviews ADD COLUMN IF NOT EXISTS ai_rated_history jsonb;
