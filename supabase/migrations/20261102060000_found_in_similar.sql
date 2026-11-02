-- Link suggestions can also come from embedding similarity ("similar": the item doesn't name the topic).
-- Replaces a check constraint on an admin-facing column: safe on live data.
ALTER TABLE matter_links DROP CONSTRAINT IF EXISTS matter_links_found_in_check,
  ADD CONSTRAINT matter_links_found_in_check CHECK (found_in IN ('item', 'document', 'spoken', 'report', 'topic', 'similar'));
