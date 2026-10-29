DROP FUNCTION IF EXISTS claim_next_pipeline_job(text);

CREATE OR REPLACE FUNCTION claim_next_pipeline_job(
    worker_id text,
    job_types text[] DEFAULT NULL
)
RETURNS SETOF pipeline_jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    RETURN QUERY
    WITH next_job AS (
        SELECT pj.id
        FROM pipeline_jobs pj
        WHERE pj.status = 'queued'
          AND pj.attempt_count < pj.max_attempts
          AND (job_types IS NULL OR pj.job_type = ANY(job_types))
          AND (
              NOT (pj.args ? 'source_meeting_id')
              OR pg_try_advisory_xact_lock(
                  pj.municipality_id::integer,
                  hashtext(pj.args->>'source_meeting_id')
              )
          )
          AND NOT EXISTS (
              SELECT 1
              FROM pipeline_jobs running
              WHERE running.status = 'running'
                AND running.id <> pj.id
                AND running.municipality_id = pj.municipality_id
                AND running.args ? 'source_meeting_id'
                AND pj.args ? 'source_meeting_id'
                AND running.args->>'source_meeting_id' = pj.args->>'source_meeting_id'
          )
        ORDER BY pj.priority DESC, pj.requested_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
    )
    UPDATE pipeline_jobs
    SET status = 'running',
        locked_by = worker_id,
        locked_at = timezone('utc'::text, now()),
        started_at = COALESCE(started_at, timezone('utc'::text, now())),
        attempt_count = attempt_count + 1,
        last_error = NULL
    WHERE id IN (SELECT id FROM next_job)
    RETURNING pipeline_jobs.*;
END;
$$;
