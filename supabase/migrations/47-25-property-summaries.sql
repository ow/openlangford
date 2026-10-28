-- Plain-language overview per property, written by the pipeline's property-summaries stage:
-- meta.summary, meta.summary_version (prompt version), meta.summary_inputs (hash of the linked
-- record set, for --stale), meta.summary_updated_at. Apply before deploying the web app, which
-- selects properties.meta on property pages.
ALTER TABLE properties ADD COLUMN IF NOT EXISTS meta jsonb NOT NULL DEFAULT '{}'::jsonb;
