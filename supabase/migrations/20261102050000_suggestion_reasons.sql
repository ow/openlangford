-- Why a link was suggested (the reviewer model's one-line reason) and where the name was found
-- (the item's own text, an attached document, or said at the meeting), shown in the page review bar.
-- Columns added to existing tables: safe on live data.
ALTER TABLE matter_links ADD COLUMN IF NOT EXISTS suggest_reason text;
ALTER TABLE matter_links ADD COLUMN IF NOT EXISTS found_in text CHECK (found_in IN ('item', 'document', 'spoken', 'report', 'topic'));
ALTER TABLE matter_report_mentions ADD COLUMN IF NOT EXISTS suggest_reason text;
