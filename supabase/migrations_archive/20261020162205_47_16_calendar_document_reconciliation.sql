-- Document discovery may first supply an eSCRIBE GUID after the scheduled date.
-- This only links an existing verified calendar record; it never publishes a new one.
CREATE OR REPLACE FUNCTION public.reconcile_calendar_source(p_source_meeting_id bigint)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE source source_meetings%ROWTYPE; candidate bigint; matches bigint; siblings bigint; org_name text;
BEGIN
  SELECT * INTO STRICT source FROM source_meetings WHERE id=p_source_meeting_id FOR UPDATE;
  IF source.municipality_id<>(SELECT id FROM municipalities WHERE slug='langford') OR source.source_type<>'escribe' THEN RETURN NULL; END IF;
  IF source.ingested_meeting_id IS NOT NULL THEN
    IF NOT EXISTS(SELECT 1 FROM meetings WHERE id=source.ingested_meeting_id AND municipality_id=source.municipality_id) THEN
      RAISE EXCEPTION 'Calendar source mapping crosses municipality';
    END IF;
    RETURN source.ingested_meeting_id;
  END IF;
  org_name:=CASE WHEN source.meeting_type='Advisory Committee' THEN source.title ELSE 'Council' END;
  SELECT count(*),min(m.id) INTO matches,candidate FROM meetings m
    JOIN organizations o ON o.id=m.organization_id
    WHERE m.municipality_id=source.municipality_id AND m.calendar_source_id IS NOT NULL
      AND m.meeting_date=source.meeting_date AND m.type::text=source.meeting_type AND o.name=org_name
      AND NOT EXISTS(SELECT 1 FROM source_meetings alias WHERE alias.ingested_meeting_id=m.id
        AND alias.source_type='escribe' AND alias.id<>source.id);
  SELECT count(*) INTO siblings FROM source_meetings s WHERE s.municipality_id=source.municipality_id
    AND s.source_type='escribe' AND s.meeting_date=source.meeting_date AND s.meeting_type=source.meeting_type
    AND (source.meeting_type<>'Advisory Committee' OR s.title=source.title);
  IF matches>1 OR (matches=1 AND siblings>1) THEN
    RAISE EXCEPTION 'Ambiguous published sources for calendar placeholder; review before ingestion';
  END IF;
  IF matches=0 THEN
    IF EXISTS(SELECT 1 FROM meetings m JOIN organizations o ON o.id=m.organization_id
      JOIN source_meetings origin ON origin.id=m.calendar_source_id
      WHERE m.municipality_id=source.municipality_id AND m.type::text=source.meeting_type
        AND o.name=org_name AND abs(m.meeting_date-source.meeting_date)<=14
        AND origin.source_type='official_schedule'
        AND NOT EXISTS(SELECT 1 FROM source_meetings alias WHERE alias.ingested_meeting_id=m.id AND alias.source_type='escribe')) THEN
      RAISE EXCEPTION 'Possible calendar reschedule requires review before ingestion';
    END IF;
    RETURN NULL;
  END IF;
  PERFORM id FROM meetings WHERE id=candidate FOR UPDATE;
  UPDATE source_meetings SET ingested_meeting_id=candidate WHERE id=source.id;
  RETURN candidate;
END $$;
REVOKE ALL ON FUNCTION public.reconcile_calendar_source(bigint) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_calendar_source(bigint) TO service_role;
NOTIFY pgrst, 'reload schema';
