-- Pages staff took off the public site from the review bar ("Hide page"): meetings, properties, participants and
-- elections. Keyed by the record, not the URL, so a changed slug can't bring a hidden page back. Topics keep their
-- own flag (matters.meta.hidden = 'staff'), which the pipeline and topic lists already respect. Why it was hidden is
-- the page's internal note (page_reviews.internal_note), required when hiding.
CREATE TABLE IF NOT EXISTS public.hidden_pages (
  record_table text NOT NULL CHECK (record_table IN ('meetings', 'properties', 'people', 'elections')),
  record_id bigint NOT NULL,
  path text NOT NULL,
  hidden_by uuid,
  hidden_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (record_table, record_id)
);

ALTER TABLE public.hidden_pages ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.hidden_pages FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.hidden_pages TO service_role;

-- Public routes that must not use admin access (the Markdown representations) ask only whether one record is hidden.
CREATE OR REPLACE FUNCTION public.page_hidden(p_table text, p_id bigint)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (SELECT 1 FROM public.hidden_pages WHERE record_table = p_table AND record_id = p_id);
$$;
REVOKE ALL ON FUNCTION public.page_hidden(text, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.page_hidden(text, bigint) TO anon, authenticated, service_role;
