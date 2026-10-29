-- MANUAL PROPOSAL ONLY: do not apply as part of deploying the web app.
-- Apply 20261020150531_47_14_inauguration_meeting_type.sql and COMMIT it first.
-- Source: https://langford.ca/election-2026/ (Key Election Dates).
-- Scope: one Langford council event on November 2, 2026. Preserve any existing
-- id/slug/links/content. Never inserts a missing event.
-- After verifying the exact placeholder, set its id in the SAME session:
--   SET openlangford.correction_meeting_id = '<verified-id>';
BEGIN;
LOCK TABLE meetings IN SHARE ROW EXCLUSIVE MODE;
DO $$
DECLARE
  municipality bigint;
  council bigint;
  candidate bigint;
  candidates bigint;
  verified_id bigint := nullif(current_setting('openlangford.correction_meeting_id', true), '')::bigint;
BEGIN
  IF verified_id IS NULL THEN
    RAISE EXCEPTION 'Set the verified placeholder ID before running this correction';
  END IF;
  SELECT id INTO STRICT municipality FROM municipalities WHERE slug = 'langford';
  SELECT id INTO STRICT council FROM organizations
    WHERE municipality_id = municipality AND classification = 'Council' AND name = 'Council';

  SELECT count(*), min(id) INTO candidates, candidate FROM meetings
    WHERE municipality_id = municipality AND meeting_date = DATE '2026-11-02'
      AND (organization_id = council OR organization_id IS NULL)
      AND type IN ('Regular Council', 'Special Council', 'Inauguration');
  IF candidates > 1 THEN
    RAISE EXCEPTION 'Ambiguous November 2 council events; review exact IDs before correcting';
  END IF;

  IF candidates = 0 THEN
    RAISE EXCEPTION 'No November 2 placeholder exists; no event will be created';
  END IF;
  IF candidate <> verified_id THEN
    RAISE EXCEPTION 'November 2 placeholder does not match the verified ID';
  END IF;

  IF candidates = 1 THEN
    IF EXISTS (SELECT 1 FROM meetings WHERE id = candidate
      AND (archive_path IS NOT NULL OR has_agenda OR has_minutes OR has_transcript
        OR summary IS NOT NULL OR status = 'Cancelled')) THEN
      RAISE EXCEPTION 'November 2 event has content or is cancelled; review before correcting';
    END IF;
    UPDATE meetings SET title = 'Inauguration', type = 'Inauguration'
      WHERE id = candidate;
  END IF;
END $$;
-- Return the corrected row for verification; rerunning preserves its id and slug.
SELECT id, slug, title, type, meeting_date, status FROM meetings
  WHERE municipality_id = (SELECT id FROM municipalities WHERE slug = 'langford')
    AND meeting_date = DATE '2026-11-02';
COMMIT;
