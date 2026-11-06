-- Each saved AI answer keeps the request that produced it, so the admin home can show what each question cost
-- (ai_usage rows share that request_id: agent steps, rerank, the answer, follow-ups). Service role only, like the
-- rest of the table. Existing answers get the answer-stage request that finished closest to when they were saved.
ALTER TABLE public.search_results_cache ADD COLUMN IF NOT EXISTS request_id text;

UPDATE public.search_results_cache c SET request_id = (
  SELECT u.request_id FROM public.ai_usage u
   WHERE u.source = 'web' AND u.stage = 'answer' AND u.request_id IS NOT NULL
     AND u.created_at BETWEEN c.created_at - interval '3 minutes' AND c.created_at + interval '30 seconds'
   ORDER BY abs(extract(epoch FROM u.created_at - c.created_at)) LIMIT 1)
WHERE c.request_id IS NULL;

CREATE INDEX IF NOT EXISTS search_results_cache_created_at_idx ON public.search_results_cache (created_at DESC);
