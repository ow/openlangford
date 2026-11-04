-- Log tables stop growing forever. ai_usage (one row per model call, ~100k a week) keeps 90 days of raw rows; older
-- days are rolled into ai_usage_daily first, so long-run cost and failure history survives. pipeline_run_events (job
-- progress lines) keeps 90 days. The Worker's twice-daily retention run calls apply_log_retention(); each call
-- moves at most one batch per table so a backlog clears over a few runs instead of in one long transaction.

CREATE TABLE IF NOT EXISTS public.ai_usage_daily (
  day date NOT NULL,
  source text NOT NULL DEFAULT '',
  stage text NOT NULL DEFAULT '',
  operation text NOT NULL DEFAULT '',
  model text NOT NULL DEFAULT '',
  calls bigint NOT NULL DEFAULT 0,
  failures bigint NOT NULL DEFAULT 0,
  input_tokens bigint NOT NULL DEFAULT 0,
  output_tokens bigint NOT NULL DEFAULT 0,
  latency_ms bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (day, source, stage, operation, model)
);
ALTER TABLE public.ai_usage_daily ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ai_usage_daily FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.ai_usage_daily TO service_role;

CREATE INDEX IF NOT EXISTS pipeline_run_events_created_at_idx ON public.pipeline_run_events (created_at);

CREATE OR REPLACE FUNCTION public.apply_log_retention(p_keep_days integer DEFAULT 90, p_batch integer DEFAULT 50000, p_dry_run boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE
  -- Whole UTC days only, so a rolled-up day is never split between raw rows and the summary.
  v_cutoff timestamptz := date_trunc('day', now(), 'UTC') - make_interval(days => greatest(p_keep_days, 30));
  v_usage bigint;
  v_events bigint;
BEGIN
  IF p_dry_run THEN
    SELECT count(*) INTO v_usage FROM ai_usage WHERE created_at < v_cutoff;
    SELECT count(*) INTO v_events FROM pipeline_run_events WHERE created_at < v_cutoff;
    RETURN jsonb_build_object('dry_run', true, 'cutoff', v_cutoff, 'ai_usage_due', v_usage, 'run_events_due', v_events);
  END IF;

  WITH moved AS (
    DELETE FROM ai_usage WHERE id IN (
      SELECT id FROM ai_usage WHERE created_at < v_cutoff ORDER BY created_at LIMIT p_batch)
    RETURNING created_at, source, stage, operation, model, ok, input_tokens, output_tokens, latency_ms
  ), daily AS (
    INSERT INTO ai_usage_daily AS d (day, source, stage, operation, model, calls, failures, input_tokens, output_tokens, latency_ms)
    SELECT (created_at AT TIME ZONE 'UTC')::date, coalesce(source, ''), coalesce(stage, ''), coalesce(operation, ''), coalesce(model, ''),
           count(*), count(*) FILTER (WHERE NOT ok), coalesce(sum(input_tokens), 0), coalesce(sum(output_tokens), 0), coalesce(sum(latency_ms), 0)
      FROM moved GROUP BY 1, 2, 3, 4, 5
    ON CONFLICT (day, source, stage, operation, model) DO UPDATE SET
      calls = d.calls + excluded.calls, failures = d.failures + excluded.failures,
      input_tokens = d.input_tokens + excluded.input_tokens, output_tokens = d.output_tokens + excluded.output_tokens,
      latency_ms = d.latency_ms + excluded.latency_ms
    RETURNING 1
  )
  SELECT count(*) INTO v_usage FROM moved;

  DELETE FROM pipeline_run_events WHERE id IN (
    SELECT id FROM pipeline_run_events WHERE created_at < v_cutoff ORDER BY created_at LIMIT p_batch);
  GET DIAGNOSTICS v_events = ROW_COUNT;

  RETURN jsonb_build_object('dry_run', false, 'cutoff', v_cutoff, 'ai_usage_rolled_up', v_usage, 'run_events_deleted', v_events);
END $$;
REVOKE ALL ON FUNCTION public.apply_log_retention(integer, integer, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_log_retention(integer, integer, boolean) TO service_role;
