-- Cache for expensive, read-mostly page computations (e.g. public participant stats).
-- Rows are recomputed when older than the latest ingested meeting; served stale meanwhile.
CREATE TABLE IF NOT EXISTS computed_cache (
  key text PRIMARY KEY,
  payload jsonb NOT NULL,
  computed_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE computed_cache ENABLE ROW LEVEL SECURITY;
-- No public policies: read and written by the web app's service-role client only.
