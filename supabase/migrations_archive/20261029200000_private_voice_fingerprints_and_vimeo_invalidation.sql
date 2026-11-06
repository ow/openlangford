-- 1. Voice fingerprints are voice embeddings of named people: service role only.
-- The table had a public SELECT policy from bootstrap. Its only readers are the pipeline
-- (secret key) and the admin-only /speaker-alias page (now via the service-role client).
DROP POLICY IF EXISTS "Allow public read-only access on voice_fingerprints" ON public.voice_fingerprints;
ALTER TABLE public.voice_fingerprints ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.voice_fingerprints FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.voice_fingerprints TO service_role;

-- 2. Clear a meeting's cached Vimeo URLs in one statement, so a viewer's "video failed"
-- report can't overwrite meta written concurrently (the old route read, merged and wrote
-- the whole object). Returns the meeting's video_url, or no row if the meeting doesn't exist.
CREATE OR REPLACE FUNCTION public.invalidate_meeting_vimeo_cache(p_meeting_id bigint)
RETURNS TABLE (video_url text)
LANGUAGE sql
SET search_path = public
AS $$
  UPDATE public.meetings
  SET meta = COALESCE(meta, '{}'::jsonb) || jsonb_build_object(
    'vimeo_direct_url', NULL,
    'vimeo_direct_audio_url', NULL,
    'vimeo_direct_url_updated_at', NULL,
    'vimeo_cache_invalidated_at', to_jsonb(now())
  )
  WHERE id = p_meeting_id
  RETURNING meetings.video_url;
$$;
REVOKE ALL ON FUNCTION public.invalidate_meeting_vimeo_cache(bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.invalidate_meeting_vimeo_cache(bigint) TO service_role;
