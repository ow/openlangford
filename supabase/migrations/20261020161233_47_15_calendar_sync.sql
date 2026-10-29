-- Trusted calendar publication is separate from document readiness. No historical backfill.
ALTER TABLE public.meetings ADD COLUMN IF NOT EXISTS calendar_source_id bigint
  REFERENCES public.source_meetings(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX IF NOT EXISTS meetings_calendar_source_unique ON public.meetings(calendar_source_id);
CREATE TABLE IF NOT EXISTS public.calendar_sync_state (
  municipality_id bigint PRIMARY KEY REFERENCES public.municipalities(id),
  token uuid, lease_until timestamptz, started_at timestamptz, finished_at timestamptz,
  last_trigger text NOT NULL DEFAULT 'manual',
  status text NOT NULL, result jsonb NOT NULL DEFAULT '{}', last_error text
);
ALTER TABLE public.calendar_sync_state ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.claim_calendar_sync(p_trigger text DEFAULT 'manual') RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE run uuid := gen_random_uuid(); muni bigint;
BEGIN
  IF p_trigger NOT IN ('manual','cron') THEN RAISE EXCEPTION 'Unknown calendar trigger'; END IF;
  SELECT id INTO STRICT muni FROM municipalities WHERE slug='langford';
  INSERT INTO calendar_sync_state(municipality_id,token,lease_until,started_at,status,last_trigger)
    VALUES(muni,run,now()+interval '5 minutes',now(),'running',p_trigger)
    ON CONFLICT(municipality_id) DO UPDATE SET token=excluded.token,
      lease_until=excluded.lease_until,started_at=excluded.started_at,finished_at=NULL,
      last_trigger=excluded.last_trigger,status='running',last_error=NULL
    WHERE calendar_sync_state.lease_until IS NULL OR calendar_sync_state.lease_until<now();
  IF NOT FOUND THEN RETURN NULL; END IF;
  RETURN run;
END $$;

CREATE OR REPLACE FUNCTION public.fail_calendar_sync(p_token uuid,p_error text) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path=public AS $$
  UPDATE calendar_sync_state SET status='failed',finished_at=now(),lease_until=NULL,
    last_error=left(p_error,300) WHERE token=p_token AND status='running';
$$;

CREATE OR REPLACE FUNCTION public.apply_calendar_sync(p_token uuid,p_events jsonb,p_warnings jsonb DEFAULT '[]')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE
  muni bigint; item jsonb; source_row source_meetings%ROWTYPE; org bigint; target bigint;
  candidates bigint; match_id bigint; event_date date; today date := (now() AT TIME ZONE 'America/Vancouver')::date;
  created_count int:=0; updated_count int:=0; held_count int:=0; typ meeting_type; provenance jsonb;
BEGIN
  SELECT municipality_id INTO STRICT muni FROM calendar_sync_state
    WHERE token=p_token AND status='running' AND lease_until>now() FOR UPDATE;
  IF coalesce(jsonb_typeof(p_events),'')<>'array' OR jsonb_array_length(p_events)>64 THEN
    RAISE EXCEPTION 'Calendar batch exceeds allowed size';
  END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(p_events) LOOP
    event_date := (item->>'meeting_date')::date;
    IF coalesce(item->>'source_type','') NOT IN ('escribe','official_schedule')
       OR coalesce(length(item->>'source_id'),0) NOT BETWEEN 1 AND 150
       OR coalesce(length(item->>'title'),0) NOT BETWEEN 1 AND 150
       OR coalesce(item->>'cancelled','') NOT IN ('true','false')
       OR ((item->>'start_time') IS NOT NULL AND item->>'start_time' !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$')
       OR coalesce(item->>'type','') NOT IN ('Regular Council','Special Council','Inauguration','Committee of the Whole','Public Hearing','Advisory Committee')
       OR coalesce(item->>'organization_name','') NOT IN ('Council','Community Advisory Committee','Sustainable Development Advisory Committee','Capital West Accessibility Advisory Committee')
       OR coalesce(item->>'source_url','') NOT IN (
         'https://pub-langford.escribemeetings.com/meetingscalendarview.aspx',
         'https://langford.ca/wp-content/uploads/2025/12/2026-Council-Year-Calendar-Council-Committees.pdf')
       OR event_date IS NULL OR event_date>today+180 OR event_date<today THEN
      RAISE EXCEPTION 'Unverified or out-of-window calendar event';
    END IF;
    typ := (item->>'type')::meeting_type;
    SELECT id INTO org FROM organizations WHERE municipality_id=muni AND name=item->>'organization_name';
    IF org IS NULL THEN
      INSERT INTO organizations(name,municipality_id,classification)
        VALUES(item->>'organization_name',muni,'Committee') RETURNING id INTO org;
    END IF;
    -- Preserve documents/archive metadata and the source's existing public-record link.
    INSERT INTO source_meetings(municipality_id,source_type,source_id,meeting_date,title,meeting_type,source_url,raw,status)
      VALUES(muni,item->>'source_type',item->>'source_id',event_date,item->>'title',item->>'type',item->>'source_url',
        jsonb_build_object('calendar',item),'scheduled')
      ON CONFLICT(municipality_id,source_type,source_id) DO UPDATE SET
        last_seen_at=now(),raw=source_meetings.raw||excluded.raw,
        meeting_date=excluded.meeting_date,title=excluded.title,meeting_type=excluded.meeting_type,
        source_url=coalesce(source_meetings.source_url,excluded.source_url)
      RETURNING * INTO source_row;
    target := source_row.ingested_meeting_id;
    IF target IS NULL THEN
      SELECT id INTO target FROM meetings WHERE calendar_source_id=source_row.id;
    END IF;
    IF target IS NOT NULL AND NOT EXISTS(SELECT 1 FROM meetings WHERE id=target AND municipality_id=muni) THEN
      RAISE EXCEPTION 'Calendar source mapping crosses municipality';
    END IF;
    IF target IS NOT NULL AND item->>'source_type'='official_schedule' AND EXISTS(
       SELECT 1 FROM source_meetings WHERE ingested_meeting_id=target AND source_type='escribe') THEN
      CONTINUE; -- Published identity always outranks the annual schedule, even after rescheduling.
    END IF;
    IF target IS NULL AND item->>'source_type'='escribe' THEN
      -- Bind one future reviewed schedule entry to its published eSCRIBE identity.
      -- Multiple same-day/source events are held, never collapsed by date/type alone.
      SELECT count(*),min(m.id) INTO candidates,match_id FROM meetings m
        JOIN source_meetings s ON s.id=m.calendar_source_id
        WHERE m.municipality_id=muni AND m.organization_id=org AND m.type=typ
          AND m.meeting_date=event_date AND s.source_type='official_schedule'
          AND (m.meta->'calendar'->>'start_time' IS NULL OR item->>'start_time' IS NULL
            OR m.meta->'calendar'->>'start_time'=item->>'start_time')
          AND NOT EXISTS(SELECT 1 FROM source_meetings alias WHERE alias.ingested_meeting_id=m.id
            AND alias.source_type='escribe' AND alias.source_id<>source_row.source_id);
      IF candidates>1 OR (candidates=1 AND (SELECT count(*) FROM jsonb_array_elements(p_events) e
          WHERE e->>'source_type'='escribe' AND e->>'meeting_date'=event_date::text
          AND e->>'type'=typ::text AND e->>'organization_name'=item->>'organization_name')>1) THEN
        held_count:=held_count+1; CONTINUE;
      END IF;
      IF candidates=1 THEN target:=match_id; END IF;
      IF candidates=0 AND EXISTS(SELECT 1 FROM meetings m JOIN source_meetings s ON s.id=m.calendar_source_id
          WHERE m.municipality_id=muni AND m.organization_id=org AND m.type=typ
            AND s.source_type='official_schedule' AND abs(m.meeting_date-event_date)<=14
            AND NOT EXISTS(SELECT 1 FROM source_meetings alias WHERE alias.ingested_meeting_id=m.id AND alias.source_type='escribe')) THEN
        held_count:=held_count+1; CONTINUE; -- Possible reschedule before identity was established.
      END IF;
    END IF;
    -- Avoid creating a schedule duplicate if a public processed record already exists
    -- without a source mapping. This needs explicit reconciliation, not a blind merge.
    IF target IS NULL AND EXISTS(SELECT 1 FROM meetings m LEFT JOIN source_meetings s ON s.id=m.calendar_source_id
       WHERE m.municipality_id=muni AND m.organization_id=org AND m.meeting_date=event_date AND m.type=typ
         AND (item->>'source_type'='official_schedule' OR m.calendar_source_id IS NULL OR s.source_type='official_schedule')) THEN
      held_count:=held_count+1; CONTINUE;
    END IF;
    provenance:=jsonb_build_object('source_url',item->>'source_url','source_id',item->>'source_id',
      'source_type',item->>'source_type','verified_at',now(),'start_time',item->'start_time');
    IF target IS NULL THEN
      INSERT INTO meetings(municipality_id,organization_id,title,meeting_date,type,status,calendar_source_id,meta)
        VALUES(muni,org,item->>'title',event_date,typ,CASE WHEN (item->>'cancelled')::boolean THEN 'Cancelled' ELSE 'Planned' END,
          source_row.id,jsonb_build_object('calendar',provenance)) RETURNING id INTO target;
      created_count:=created_count+1;
    ELSE
      -- Calendar refresh cannot erase content, downgrade a completed meeting, or un-cancel one.
      UPDATE meetings SET calendar_source_id=coalesce(calendar_source_id,source_row.id),
        title=CASE WHEN archive_path IS NULL AND status='Planned' THEN item->>'title' ELSE title END,
        type=CASE WHEN archive_path IS NULL AND status='Planned' THEN typ ELSE type END,
        organization_id=CASE WHEN archive_path IS NULL AND status='Planned' THEN org ELSE organization_id END,
        meta=coalesce(meta,'{}')||jsonb_build_object('calendar',provenance),
        meeting_date=CASE WHEN archive_path IS NULL AND NOT coalesce(has_agenda,false)
          AND NOT coalesce(has_minutes,false) AND NOT coalesce(has_transcript,false) THEN event_date ELSE meeting_date END,
        status=CASE WHEN (item->>'cancelled')::boolean AND status='Planned' THEN 'Cancelled' ELSE status END
        WHERE id=target AND municipality_id=muni;
      updated_count:=updated_count+1;
    END IF;
    UPDATE source_meetings SET ingested_meeting_id=target WHERE id=source_row.id;
  END LOOP;
  provenance:=jsonb_build_object('created',created_count,'updated',updated_count,'held',held_count,'warnings',p_warnings);
  UPDATE calendar_sync_state SET status='succeeded',finished_at=now(),lease_until=NULL,result=provenance,last_error=NULL
    WHERE token=p_token;
  RETURN provenance;
END $$;
REVOKE ALL ON FUNCTION public.claim_calendar_sync(text), public.fail_calendar_sync(uuid,text),
  public.apply_calendar_sync(uuid,jsonb,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.claim_calendar_sync(text), public.fail_calendar_sync(uuid,text),
  public.apply_calendar_sync(uuid,jsonb,jsonb) TO service_role;

NOTIFY pgrst, 'reload schema';
