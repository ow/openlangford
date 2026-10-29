-- Remove the pre-date-filter overload so PostgREST can resolve named RPC calls.
DROP FUNCTION IF EXISTS hybrid_search_document_sections(
  text,
  halfvec(384),
  int,
  float,
  float,
  int
);
