-- Two vector indexes that no query has ever used (0 scans in their lifetime) but every embedding write maintains:
-- agenda_items (14 MB) and documents (2 MB). The embeddings themselves stay. To bring one back:
--   CREATE INDEX idx_agenda_items_embedding ON public.agenda_items USING hnsw (embedding halfvec_cosine_ops);
--   CREATE INDEX idx_documents_embedding ON public.documents USING hnsw (embedding halfvec_cosine_ops);
DROP INDEX IF EXISTS public.idx_agenda_items_embedding;
DROP INDEX IF EXISTS public.idx_documents_embedding;
