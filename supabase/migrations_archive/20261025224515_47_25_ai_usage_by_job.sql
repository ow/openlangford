-- Tie AI usage to the pipeline job that caused it, so /admin/pipeline can show
-- tokens and an estimated cost per job (cost is computed at read time from
-- token counts; see app/services/ai/pricing.ts). Older rows have no job id.
ALTER TABLE ai_usage ADD COLUMN IF NOT EXISTS pipeline_job_id bigint REFERENCES pipeline_jobs(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS ai_usage_pipeline_job_idx ON ai_usage (pipeline_job_id) WHERE pipeline_job_id IS NOT NULL;

-- One row per (job, stage, model, operation): small enough to read for a page of jobs.
CREATE OR REPLACE VIEW ai_usage_by_job WITH (security_invoker = true) AS
SELECT pipeline_job_id, stage, model, operation,
       count(*)::int AS calls,
       count(*) FILTER (WHERE NOT ok)::int AS failed,
       coalesce(sum(input_tokens), 0)::bigint AS input_tokens,
       coalesce(sum(output_tokens), 0)::bigint AS output_tokens
FROM ai_usage
WHERE pipeline_job_id IS NOT NULL
GROUP BY pipeline_job_id, stage, model, operation;
