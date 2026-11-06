-- eSCRIBE lists distinct meetings of the same type on the same date (for
-- example, Langford Special Council meetings at 5:00 and 5:15 p.m.).
-- archive_path remains unique and is the ingestion identity for archived PDFs.
DROP INDEX IF EXISTS idx_meetings_muni_date_type;
CREATE INDEX idx_meetings_muni_date_type
    ON meetings(municipality_id, meeting_date, type);
