-- PROPOSAL ONLY (not applied, not in supabase/migrations). Needed only for `correct_meeting_dates.py --rename-slugs`.
-- Old meeting slugs must keep resolving (301) after a slug is renamed; the web app has no such support today.
CREATE TABLE IF NOT EXISTS public.meeting_slug_history (
  id          bigserial PRIMARY KEY,
  meeting_id  bigint NOT NULL REFERENCES public.meetings(id) ON DELETE CASCADE,
  old_slug    text   NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
-- Slugs are unique per municipality in `meetings`; keep history unambiguous the same way.
CREATE UNIQUE INDEX IF NOT EXISTS meeting_slug_history_old_slug_key ON public.meeting_slug_history (old_slug);
ALTER TABLE public.meeting_slug_history ENABLE ROW LEVEL SECURITY;
CREATE POLICY meeting_slug_history_read ON public.meeting_slug_history FOR SELECT USING (true);

-- Web side (apps/web/app/lib/slug-params.server.ts, resolveSlugParam), after the `if (data)` slug lookup and
-- before the legacy matter/bylaw block:
--
--   if (table === "meetings") {
--     const { data: hist } = await supabase.from("meeting_slug_history").select("meeting_id").eq("old_slug", slug).maybeSingle();
--     if (hist) {
--       const row = await byId(hist.meeting_id);
--       if (row?.slug && row.slug !== slug) {
--         if (!redirectLegacy) return row;
--         throw redirect(buildPath(row) + search, 301);
--       }
--     }
--   }
