-- Hybrid search still read every embedding on each call. 20261029161500 switched the document search to
-- ORDER BY ... LIMIT so it could use the HNSW index, but a function with SET clauses is never inlined, so its
-- body was planned once with the arguments as unknown parameters. The planner then guessed a parameterised
-- LIMIT returns 10% of the table, priced the index above a full scan and sort, and never used it (6 scans in
-- the index's lifetime). Each document search touched 37k-90k buffers (0.3-0.7 GB) on a 1 GB server.
--
-- Rewrite the three hybrid searches in PL/pgSQL with plan_cache_mode = force_custom_plan, so each call is
-- planned with its real values: the LIMIT is a constant, NULL date filters drop out, and the full-text half
-- can hash-join meetings for common words instead of probing it once per match. The nearest-neighbour half
-- takes a literal 60 rows (twice the 30-row cap) and keeps the first LEAST(match_count, 30) * 2 by distance,
-- so it uses the index even if this setting is ever lost. Motions and key statements still ranked with
-- ROW_NUMBER() OVER (ORDER BY embedding <=> q), which can never use the index; they get the same shape.
-- ef_search 400 (from 100): against an exact scan, the index found 86% of the 30 nearest sections at 100,
-- 94% at 200 and 97% at 400; motions needed 400 to get past 82%. That costs ~3-5k buffers a call, against
-- the ~11-36k an exact scan reads. Signatures and grants are unchanged; results match the old exact search
-- except where the index misses a near neighbour.

-- pgvector's hnsw.* settings exist only once its library is loaded in this session; a function cannot SET a
-- setting the server doesn't know yet without superuser rights, which migrations don't have. A cast loads it.
SELECT '[1]'::halfvec;

CREATE OR REPLACE FUNCTION public.hybrid_search_document_sections(query_text text, query_embedding halfvec, match_count integer, full_text_weight double precision DEFAULT 1, semantic_weight double precision DEFAULT 1, rrf_k integer DEFAULT 50, date_from date DEFAULT NULL::date, date_to date DEFAULT NULL::date, filter_municipality_id bigint DEFAULT NULL::bigint)
 RETURNS TABLE(id bigint, document_id bigint, meeting_id bigint, agenda_item_id bigint, section_title text, content text, rank_score double precision)
 LANGUAGE plpgsql
 SET search_path TO 'public'
 SET hnsw.ef_search TO '400'
 SET hnsw.iterative_scan TO 'relaxed_order'
 SET plan_cache_mode TO 'force_custom_plan'
AS $function$
#variable_conflict use_column
DECLARE
  k integer := LEAST(match_count, 30) * 2;
BEGIN
  RETURN QUERY
  WITH full_text AS (
    SELECT
      ds.id,
      ROW_NUMBER() OVER (ORDER BY ts_rank_cd(ds.text_search, websearch_to_tsquery(query_text)) DESC) AS rank_ix
    FROM document_sections ds
    JOIN documents d ON d.id = ds.document_id
    JOIN meetings mt ON mt.id = d.meeting_id
    WHERE ds.text_search @@ websearch_to_tsquery(query_text)
      AND (date_from IS NULL OR mt.meeting_date >= date_from)
      AND (date_to IS NULL OR mt.meeting_date <= date_to)
      AND (filter_municipality_id IS NULL OR ds.municipality_id = filter_municipality_id)
    ORDER BY rank_ix
    LIMIT k
  ),
  nearest AS (
    SELECT ds.id, ds.embedding <=> query_embedding AS distance
    FROM document_sections ds
    JOIN documents d ON d.id = ds.document_id
    JOIN meetings mt ON mt.id = d.meeting_id
    WHERE ds.embedding IS NOT NULL
      AND (date_from IS NULL OR mt.meeting_date >= date_from)
      AND (date_to IS NULL OR mt.meeting_date <= date_to)
      AND (filter_municipality_id IS NULL OR ds.municipality_id = filter_municipality_id)
    ORDER BY ds.embedding <=> query_embedding
    LIMIT 60
  ),
  semantic AS (
    SELECT n.id, n.rank_ix
    FROM (SELECT nearest.id, ROW_NUMBER() OVER (ORDER BY nearest.distance) AS rank_ix FROM nearest) n
    WHERE n.rank_ix <= k
  )
  SELECT
    document_sections.id,
    document_sections.document_id,
    documents.meeting_id,
    document_sections.agenda_item_id,
    document_sections.section_title,
    LEFT(document_sections.section_text, 500) AS content,
    (COALESCE(1.0 / (rrf_k + full_text.rank_ix), 0.0) * full_text_weight +
     COALESCE(1.0 / (rrf_k + semantic.rank_ix), 0.0) * semantic_weight)::float AS rank_score
  FROM full_text
  FULL OUTER JOIN semantic ON full_text.id = semantic.id
  JOIN document_sections ON COALESCE(full_text.id, semantic.id) = document_sections.id
  JOIN documents ON documents.id = document_sections.document_id
  ORDER BY rank_score DESC
  LIMIT LEAST(match_count, 30);
END;
$function$;

CREATE OR REPLACE FUNCTION public.hybrid_search_motions(query_text text, query_embedding halfvec, match_count integer, full_text_weight double precision DEFAULT 1, semantic_weight double precision DEFAULT 1, rrf_k integer DEFAULT 50, date_from date DEFAULT NULL::date, date_to date DEFAULT NULL::date, filter_municipality_id bigint DEFAULT NULL::bigint)
 RETURNS TABLE(id bigint, meeting_id bigint, agenda_item_id bigint, text_content text, plain_english_summary text, result text, mover text, seconder text, rank_score double precision)
 LANGUAGE plpgsql
 SET search_path TO 'public'
 SET hnsw.ef_search TO '400'
 SET hnsw.iterative_scan TO 'relaxed_order'
 SET plan_cache_mode TO 'force_custom_plan'
AS $function$
#variable_conflict use_column
DECLARE
  k integer := LEAST(match_count, 30) * 2;
BEGIN
  RETURN QUERY
  WITH full_text AS (
    SELECT
      m.id,
      ROW_NUMBER() OVER (ORDER BY ts_rank_cd(m.text_search, websearch_to_tsquery(query_text)) DESC) AS rank_ix
    FROM motions m
    JOIN meetings mt ON mt.id = m.meeting_id
    WHERE m.text_search @@ websearch_to_tsquery(query_text)
      AND (date_from IS NULL OR mt.meeting_date >= date_from)
      AND (date_to IS NULL OR mt.meeting_date <= date_to)
      AND (filter_municipality_id IS NULL OR mt.municipality_id = filter_municipality_id)
    ORDER BY rank_ix
    LIMIT k
  ),
  nearest AS (
    SELECT m.id, m.embedding <=> query_embedding AS distance
    FROM motions m
    JOIN meetings mt ON mt.id = m.meeting_id
    WHERE m.embedding IS NOT NULL
      AND (date_from IS NULL OR mt.meeting_date >= date_from)
      AND (date_to IS NULL OR mt.meeting_date <= date_to)
      AND (filter_municipality_id IS NULL OR mt.municipality_id = filter_municipality_id)
    ORDER BY m.embedding <=> query_embedding
    LIMIT 60
  ),
  semantic AS (
    SELECT n.id, n.rank_ix
    FROM (SELECT nearest.id, ROW_NUMBER() OVER (ORDER BY nearest.distance) AS rank_ix FROM nearest) n
    WHERE n.rank_ix <= k
  )
  SELECT
    motions.id,
    motions.meeting_id,
    motions.agenda_item_id,
    motions.text_content,
    motions.plain_english_summary,
    motions.result,
    motions.mover,
    motions.seconder,
    (COALESCE(1.0 / (rrf_k + full_text.rank_ix), 0.0) * full_text_weight +
     COALESCE(1.0 / (rrf_k + semantic.rank_ix), 0.0) * semantic_weight)::float AS rank_score
  FROM full_text
  FULL OUTER JOIN semantic ON full_text.id = semantic.id
  JOIN motions ON COALESCE(full_text.id, semantic.id) = motions.id
  ORDER BY rank_score DESC
  LIMIT LEAST(match_count, 30);
END;
$function$;

CREATE OR REPLACE FUNCTION public.hybrid_search_key_statements(query_text text, query_embedding halfvec, match_count integer, full_text_weight double precision DEFAULT 1, semantic_weight double precision DEFAULT 1, rrf_k integer DEFAULT 50, date_from date DEFAULT NULL::date, date_to date DEFAULT NULL::date, filter_municipality_id bigint DEFAULT NULL::bigint)
 RETURNS TABLE(id bigint, meeting_id bigint, agenda_item_id bigint, speaker_name text, statement_type text, statement_text text, context text, rank_score double precision)
 LANGUAGE plpgsql
 SET search_path TO 'public'
 SET hnsw.ef_search TO '400'
 SET hnsw.iterative_scan TO 'relaxed_order'
 SET plan_cache_mode TO 'force_custom_plan'
AS $function$
#variable_conflict use_column
DECLARE
  k integer := LEAST(match_count, 30) * 2;
BEGIN
  RETURN QUERY
  WITH full_text AS (
    SELECT
      ks.id,
      ROW_NUMBER() OVER (ORDER BY ts_rank_cd(ks.text_search, websearch_to_tsquery(query_text)) DESC) AS rank_ix
    FROM key_statements ks
    JOIN meetings mt ON mt.id = ks.meeting_id
    WHERE (ks.evidence_kind IS NULL OR ks.evidence_kind = 'transcript')
      AND ks.text_search @@ websearch_to_tsquery(query_text)
      AND (date_from IS NULL OR mt.meeting_date >= date_from)
      AND (date_to IS NULL OR mt.meeting_date <= date_to)
      AND (filter_municipality_id IS NULL OR ks.municipality_id = filter_municipality_id)
    ORDER BY rank_ix
    LIMIT k
  ),
  nearest AS (
    SELECT ks.id, ks.embedding <=> query_embedding AS distance
    FROM key_statements ks
    JOIN meetings mt ON mt.id = ks.meeting_id
    WHERE (ks.evidence_kind IS NULL OR ks.evidence_kind = 'transcript')
      AND ks.embedding IS NOT NULL
      AND (date_from IS NULL OR mt.meeting_date >= date_from)
      AND (date_to IS NULL OR mt.meeting_date <= date_to)
      AND (filter_municipality_id IS NULL OR ks.municipality_id = filter_municipality_id)
    ORDER BY ks.embedding <=> query_embedding
    LIMIT 60
  ),
  semantic AS (
    SELECT n.id, n.rank_ix
    FROM (SELECT nearest.id, ROW_NUMBER() OVER (ORDER BY nearest.distance) AS rank_ix FROM nearest) n
    WHERE n.rank_ix <= k
  )
  SELECT
    key_statements.id,
    key_statements.meeting_id,
    key_statements.agenda_item_id,
    key_statements.speaker_name,
    key_statements.statement_type,
    key_statements.statement_text,
    key_statements.context,
    (COALESCE(1.0 / (rrf_k + full_text.rank_ix), 0.0) * full_text_weight +
     COALESCE(1.0 / (rrf_k + semantic.rank_ix), 0.0) * semantic_weight)::float AS rank_score
  FROM full_text
  FULL OUTER JOIN semantic ON full_text.id = semantic.id
  JOIN key_statements ON COALESCE(full_text.id, semantic.id) = key_statements.id
  ORDER BY rank_score DESC
  LIMIT LEAST(match_count, 30);
END;
$function$;
