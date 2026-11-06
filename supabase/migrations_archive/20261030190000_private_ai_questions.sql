-- Residents' AI questions are private.
-- * search_results_cache (shared AI answers) was readable by anyone holding the
--   public key, so every recent question could be listed. The web server reads
--   and writes it with the service role only, so drop public access.
-- * Expired shared answers and the retired /api/ask traces are deleted (the
--   Worker cron keeps doing this), and stored client IPs are cleared.
-- Idempotent: safe to re-run.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- Counts only (never row contents), recorded in the migration log.
DO $$
DECLARE
  cache_rows bigint; cache_expired bigint;
  trace_rows bigint; trace_ips bigint; trace_old bigint;
  feedback_rows bigint; feedback_ips bigint;
BEGIN
  SELECT count(*), count(*) FILTER (WHERE expires_at < now())
    INTO cache_rows, cache_expired FROM public.search_results_cache;
  SELECT count(*), count(client_ip), count(*) FILTER (WHERE created_at < now() - interval '30 days')
    INTO trace_rows, trace_ips, trace_old FROM public.rag_traces;
  SELECT count(*), count(client_ip) INTO feedback_rows, feedback_ips FROM public.rag_feedback;
  RAISE NOTICE 'Before: search_results_cache % rows (% expired); rag_traces % rows (% with IP, % older than 30 days); rag_feedback % rows (% with IP)',
    cache_rows, cache_expired, trace_rows, trace_ips, trace_old, feedback_rows, feedback_ips;
END $$;

-- Shared answers: server (service role) only.
DROP POLICY IF EXISTS "Anyone can read cached results" ON public.search_results_cache;
REVOKE ALL PRIVILEGES ON TABLE public.search_results_cache FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.search_results_cache TO service_role;
DELETE FROM public.search_results_cache WHERE expires_at < now();

-- Legacy question traces and feedback: no public writes, no IPs, 30-day retention.
DROP POLICY IF EXISTS "anon_insert_rag_feedback" ON public.rag_feedback;
DROP POLICY IF EXISTS "authenticated_insert_rag_feedback" ON public.rag_feedback;
REVOKE ALL PRIVILEGES ON TABLE public.rag_traces, public.rag_feedback FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.rag_traces, public.rag_feedback TO service_role;
UPDATE public.rag_traces SET client_ip = NULL WHERE client_ip IS NOT NULL;
UPDATE public.rag_feedback SET client_ip = NULL WHERE client_ip IS NOT NULL;
DELETE FROM public.rag_traces WHERE created_at < now() - interval '30 days';  -- feedback cascades

DO $$
DECLARE cache_rows bigint; trace_rows bigint; feedback_rows bigint;
BEGIN
  SELECT count(*) INTO cache_rows FROM public.search_results_cache;
  SELECT count(*) INTO trace_rows FROM public.rag_traces;
  SELECT count(*) INTO feedback_rows FROM public.rag_feedback;
  RAISE NOTICE 'After: search_results_cache % rows; rag_traces % rows; rag_feedback % rows; no stored IPs',
    cache_rows, trace_rows, feedback_rows;
END $$;
COMMIT;
