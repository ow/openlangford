-- Migration: ai_usage
-- One row per model call (after retries) from the pipeline (pipeline/ai usage
-- hook) and the web app (services/ai onUsage), success or failure.
-- Cost is NOT stored: the admin page estimates it at read time from a
-- per-model price table, so price changes never need a backfill.
--
-- stage      = AI config stage (extraction, document, decisions, embedding, answer, ...)
-- operation  = text | json | pdf | embed | decide | transcribe | stream
-- job        = what triggered it (pipeline registry stage / CLI job, or web route)
--
-- Admin-only: RLS on, no public policies; writers/readers use the service role.
-- Safe to re-run.

CREATE TABLE IF NOT EXISTS ai_usage (
  id bigserial PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  source text NOT NULL CHECK (source IN ('pipeline', 'web')),
  stage text NOT NULL,
  operation text,
  model text NOT NULL,
  input_tokens integer,
  output_tokens integer,
  latency_ms integer,
  attempts integer,
  ok boolean NOT NULL,
  error text,
  meeting_id bigint,
  job text,
  request_id text
);

CREATE INDEX IF NOT EXISTS ai_usage_created_at_idx ON ai_usage (created_at DESC);
CREATE INDEX IF NOT EXISTS ai_usage_stage_created_at_idx ON ai_usage (stage, created_at);
CREATE INDEX IF NOT EXISTS ai_usage_failures_idx ON ai_usage (created_at DESC) WHERE NOT ok;

ALTER TABLE ai_usage ENABLE ROW LEVEL SECURITY;

-- Per-stage rollup for the admin page. Token totals are broken out per
-- (model, operation) so the caller can price them; latency percentiles are
-- per stage. SECURITY INVOKER: with RLS and no policies only the service role
-- sees rows.
CREATE OR REPLACE FUNCTION public.ai_usage_summary(since timestamptz)
RETURNS TABLE (
  source text,
  stage text,
  calls bigint,
  failures bigint,
  input_tokens bigint,
  output_tokens bigint,
  p50_latency_ms double precision,
  p95_latency_ms double precision,
  by_model jsonb
)
LANGUAGE sql STABLE
SET search_path = public
AS $$
  WITH base AS (
    SELECT * FROM ai_usage WHERE created_at >= since
  ),
  per_model AS (
    SELECT b.source, b.stage, b.model, b.operation,
           count(*) AS calls,
           coalesce(sum(b.input_tokens), 0) AS input_tokens,
           coalesce(sum(b.output_tokens), 0) AS output_tokens
    FROM base b
    GROUP BY b.source, b.stage, b.model, b.operation
  )
  SELECT b.source, b.stage,
         count(*) AS calls,
         count(*) FILTER (WHERE NOT b.ok) AS failures,
         coalesce(sum(b.input_tokens), 0) AS input_tokens,
         coalesce(sum(b.output_tokens), 0) AS output_tokens,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY b.latency_ms) AS p50_latency_ms,
         percentile_cont(0.95) WITHIN GROUP (ORDER BY b.latency_ms) AS p95_latency_ms,
         (SELECT jsonb_agg(jsonb_build_object(
                    'model', pm.model, 'operation', pm.operation, 'calls', pm.calls,
                    'input_tokens', pm.input_tokens, 'output_tokens', pm.output_tokens))
            FROM per_model pm
           WHERE pm.source = b.source AND pm.stage = b.stage) AS by_model
  FROM base b
  GROUP BY b.source, b.stage
  ORDER BY count(*) DESC;
$$;

REVOKE ALL ON FUNCTION public.ai_usage_summary(timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ai_usage_summary(timestamptz) TO service_role;
