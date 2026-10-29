-- Service-only source CAS. No source, vote, identity or transcript writes.
CREATE OR REPLACE FUNCTION public.apply_public_participation_summary(
 p_item_id integer, p_expected_item jsonb, p_expected_segments jsonb, p_after_meta jsonb
) RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $$
DECLARE actual jsonb; sources jsonb; item public.agenda_items%ROWTYPE;
BEGIN
 -- A brief SHARE lock closes insert/delete phantoms inside the source window.
 LOCK TABLE public.transcript_segments IN SHARE MODE;
 SELECT * INTO item FROM public.agenda_items WHERE id=p_item_id FOR UPDATE;
 IF NOT FOUND THEN RETURN false; END IF;
 actual := jsonb_build_object('id',item.id,'meeting_id',item.meeting_id,'title',item.title,
   'meta',item.meta,'discussion_start_time',item.discussion_start_time,'discussion_end_time',item.discussion_end_time);
 IF actual IS DISTINCT FROM p_expected_item THEN RETURN false; END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',s.id,'meeting_id',s.meeting_id,'start_time',s.start_time,
   'end_time',s.end_time,'speaker_name',s.speaker_name,'text_content',s.text_content) ORDER BY s.start_time,s.id),'[]'::jsonb)
 INTO sources FROM public.transcript_segments s WHERE s.meeting_id=item.meeting_id
   AND s.start_time<item.discussion_end_time AND s.end_time>item.discussion_start_time;
 IF sources IS DISTINCT FROM p_expected_segments THEN RETURN false; END IF;
 IF jsonb_typeof(p_after_meta) IS DISTINCT FROM 'object' OR
    (coalesce(item.meta,'{}'::jsonb)-'participation'-'participation_version'-'participation_review_hold') IS DISTINCT FROM
    (p_after_meta-'participation'-'participation_version'-'participation_review_hold') THEN
   RAISE EXCEPTION 'Unrelated agenda metadata must be preserved';
 END IF;
 UPDATE public.agenda_items SET meta=p_after_meta WHERE id=p_item_id;
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.apply_public_participation_summary(integer,jsonb,jsonb,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.apply_public_participation_summary(integer,jsonb,jsonb,jsonb) TO service_role;
