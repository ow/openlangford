-- Indexes for the web app's hot lookups. transcript_segments had no index on
-- meeting_id (175k rows → ~5s full scans per meeting page, timing out under
-- load and silently returning an empty transcript). Created CONCURRENTLY, so
-- run each statement outside a transaction.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_transcript_segments_meeting_start ON transcript_segments (meeting_id, start_time);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_transcript_segments_person ON transcript_segments (person_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_agenda_items_meeting ON agenda_items (meeting_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_motions_meeting ON motions (meeting_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_motions_agenda_item ON motions (agenda_item_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_motions_mover ON motions (mover_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_motions_seconder ON motions (seconder_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_votes_person ON votes (person_id);
