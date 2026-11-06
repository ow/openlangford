-- Enforce user ownership and reserve operational writes for trusted server roles.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- The existing own-profile SELECT/UPDATE policies now apply to this RPC.
ALTER FUNCTION public.update_user_location(uuid, double precision, double precision) SECURITY INVOKER;
REVOKE EXECUTE ON FUNCTION public.update_user_location(uuid, double precision, double precision) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.update_user_location(uuid, double precision, double precision) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.claim_next_pipeline_job(text, text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_next_pipeline_job(text, text[]) TO service_role;

REVOKE ALL PRIVILEGES ON TABLE public.search_results_cache FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.search_results_cache TO anon, authenticated;
ALTER POLICY "Service role can insert cached results" ON public.search_results_cache
    TO service_role WITH CHECK (true);
COMMIT;
