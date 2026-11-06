-- Reuse AI answers for repeat questions: look up by normalized question text.
-- The web app only serves a cached answer newer than the latest ingested
-- meeting, so new council records invalidate it automatically.
ALTER TABLE search_results_cache ADD COLUMN IF NOT EXISTS normalized_query text;
CREATE INDEX IF NOT EXISTS idx_search_cache_normalized
  ON search_results_cache (normalized_query, created_at DESC)
  WHERE normalized_query IS NOT NULL;
