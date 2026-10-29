-- The semantic half of hybrid document and bylaw search ranked with ROW_NUMBER() OVER (ORDER BY
-- embedding <=> q), which can't use the HNSW index, so every search read every embedding.
-- Take the nearest rows with ORDER BY ... LIMIT (an index scan) and number them afterwards.
-- Iterative scan keeps going when the municipality/date filters reject index candidates.

CREATE OR REPLACE FUNCTION public.hybrid_search_document_sections(query_text text, query_embedding halfvec, match_count integer, full_text_weight double precision DEFAULT 1, semantic_weight double precision DEFAULT 1, rrf_k integer DEFAULT 50, date_from date DEFAULT NULL::date, date_to date DEFAULT NULL::date, filter_municipality_id bigint DEFAULT NULL::bigint)
 RETURNS TABLE(id bigint, document_id bigint, meeting_id bigint, agenda_item_id bigint, section_title text, content text, rank_score double precision)
 LANGUAGE sql
 SET search_path TO 'public'
 SET hnsw.ef_search TO '100'
 SET hnsw.iterative_scan TO 'relaxed_order'
AS $function$
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
  LIMIT LEAST(match_count, 30) * 2
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
  LIMIT LEAST(match_count, 30) * 2
),
semantic AS (
  SELECT nearest.id, ROW_NUMBER() OVER (ORDER BY nearest.distance) AS rank_ix FROM nearest
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
$function$;

CREATE OR REPLACE FUNCTION public.hybrid_search_bylaw_chunks(query_text text, query_embedding halfvec, match_count integer, full_text_weight double precision DEFAULT 1.0, semantic_weight double precision DEFAULT 1.0, rrf_k double precision DEFAULT 50, filter_municipality_id bigint DEFAULT NULL::bigint)
 RETURNS TABLE(id bigint, bylaw_id bigint, chunk_index integer, text_content text, bylaw_title text, bylaw_number text, rank_score double precision)
 LANGUAGE sql
 SET search_path TO 'public'
 SET hnsw.ef_search TO '100'
 SET hnsw.iterative_scan TO 'relaxed_order'
AS $function$
WITH full_text AS (
  SELECT
    bc.id,
    ROW_NUMBER() OVER (ORDER BY ts_rank_cd(bc.text_search, websearch_to_tsquery(query_text)) DESC) AS rank_ix
  FROM bylaw_chunks bc
  JOIN bylaws b2 ON b2.id = bc.bylaw_id
  WHERE bc.text_search @@ websearch_to_tsquery(query_text)
    AND (filter_municipality_id IS NULL OR b2.municipality_id = filter_municipality_id)
  ORDER BY rank_ix
  LIMIT LEAST(match_count, 30) * 2
),
nearest AS (
  SELECT bc.id, bc.embedding <=> query_embedding AS distance
  FROM bylaw_chunks bc
  JOIN bylaws b2 ON b2.id = bc.bylaw_id
  WHERE bc.embedding IS NOT NULL
    AND (filter_municipality_id IS NULL OR b2.municipality_id = filter_municipality_id)
  ORDER BY bc.embedding <=> query_embedding
  LIMIT LEAST(match_count, 30) * 2
),
semantic AS (
  SELECT nearest.id, ROW_NUMBER() OVER (ORDER BY nearest.distance) AS rank_ix FROM nearest
)
SELECT
  bylaw_chunks.id,
  bylaw_chunks.bylaw_id,
  bylaw_chunks.chunk_index,
  LEFT(bylaw_chunks.text_content, 500) AS text_content,
  b.title AS bylaw_title,
  b.bylaw_number,
  (COALESCE(1.0 / (rrf_k + full_text.rank_ix), 0.0) * full_text_weight +
   COALESCE(1.0 / (rrf_k + semantic.rank_ix), 0.0) * semantic_weight)::float AS rank_score
FROM full_text
FULL OUTER JOIN semantic ON full_text.id = semantic.id
JOIN bylaw_chunks ON COALESCE(full_text.id, semantic.id) = bylaw_chunks.id
JOIN bylaws b ON bylaw_chunks.bylaw_id = b.id
ORDER BY rank_score DESC
LIMIT LEAST(match_count, 30);
$function$;
