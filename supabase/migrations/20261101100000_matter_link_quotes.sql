-- The passage that ties a mention to its matter (for links found by name, see
-- pipeline/ingestion/matter_names.py): the timeline shows it instead of the item's own summary,
-- which is often about something else. Nullable, so existing rows are untouched.
ALTER TABLE matter_links ADD COLUMN IF NOT EXISTS quote text;
