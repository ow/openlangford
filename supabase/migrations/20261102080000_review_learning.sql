-- The page check's long-term memory. Every staff rating of a flag (and every staff issue) is a labelled example,
-- kept for good; checks pull the examples most like the page being read, for its page kind and each problem
-- type. Approved written guidance (drafted from the examples, edited and approved by staff) goes into every
-- check, versioned, so agreement can be measured per version. Admin-only tables: safe on live data.
CREATE TABLE IF NOT EXISTS review_examples (
  id bigserial PRIMARY KEY,
  path text NOT NULL,
  page_kind text NOT NULL,
  entry_key text,
  problem text NOT NULL,
  entry_text text NOT NULL,
  reason text NOT NULL,
  verdict text NOT NULL CHECK (verdict IN ('agree', 'disagree')),
  note text,
  model text,
  guidance_version integer,
  rated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  embedding halfvec(384),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (path, entry_key, problem, reason)
);
CREATE INDEX IF NOT EXISTS review_examples_kind_problem ON review_examples (page_kind, problem);
CREATE INDEX IF NOT EXISTS review_examples_embedding ON review_examples USING hnsw (embedding halfvec_cosine_ops);

CREATE TABLE IF NOT EXISTS review_guidance (
  id bigserial PRIMARY KEY,
  problem text NOT NULL,
  page_kind text,
  text text NOT NULL,
  status text NOT NULL CHECK (status IN ('draft', 'approved', 'retired')),
  based_on integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  decided_at timestamptz
);
CREATE INDEX IF NOT EXISTS review_guidance_status ON review_guidance (status, problem);

-- Which guidance a check used, so agreement can be compared across versions.
ALTER TABLE page_reviews ADD COLUMN IF NOT EXISTS ai_guidance_version integer;

-- Examples for one page kind and problem, most like the page first (falls back to recency without an embedding).
CREATE OR REPLACE FUNCTION match_review_examples(query_embedding halfvec(384), kind text, problem_type text, verdict_type text, k integer)
RETURNS TABLE (id bigint, entry_text text, reason text, verdict text, note text, similarity double precision)
LANGUAGE sql STABLE AS $$
  SELECT e.id, e.entry_text, e.reason, e.verdict, e.note,
         CASE WHEN query_embedding IS NULL OR e.embedding IS NULL THEN 0 ELSE 1 - (e.embedding <=> query_embedding) END
  FROM review_examples e
  WHERE e.problem = problem_type AND e.verdict = verdict_type AND (kind IS NULL OR e.page_kind = kind)
  ORDER BY CASE WHEN query_embedding IS NULL OR e.embedding IS NULL THEN 1 ELSE 0 END,
           e.embedding <=> query_embedding, e.created_at DESC
  LIMIT k
$$;

ALTER TABLE review_examples ENABLE ROW LEVEL SECURITY;
ALTER TABLE review_guidance ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON review_examples, review_guidance FROM anon, authenticated;
GRANT ALL ON review_examples, review_guidance TO service_role;
GRANT USAGE, SELECT ON SEQUENCE review_examples_id_seq, review_guidance_id_seq TO service_role;
REVOKE ALL ON FUNCTION match_review_examples(halfvec, text, text, text, integer) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION match_review_examples(halfvec, text, text, text, integer) TO service_role;
