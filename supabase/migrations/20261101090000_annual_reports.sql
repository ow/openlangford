-- The City's annual reports (and later other reports that belong to no meeting), their text per page,
-- and the pages that mention a matter. Written by pipeline/ingestion/annual_reports.py and
-- pipeline/ingestion/matter_links.py; the matter page shows each mention as a timeline entry.
-- New tables only: safe to apply against live data.
CREATE TABLE IF NOT EXISTS public_reports (
  id bigserial PRIMARY KEY,
  municipality_id bigint NOT NULL REFERENCES municipalities(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('annual_report')),
  year integer NOT NULL,
  title text NOT NULL,
  source_url text,
  file_hash text,
  page_count integer,
  meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (municipality_id, kind, year)
);

CREATE TABLE IF NOT EXISTS public_report_pages (
  report_id bigint NOT NULL REFERENCES public_reports(id) ON DELETE CASCADE,
  page integer NOT NULL CHECK (page >= 1),
  content text NOT NULL,
  text_search tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED,
  PRIMARY KEY (report_id, page)
);
CREATE INDEX IF NOT EXISTS public_report_pages_search ON public_report_pages USING gin (text_search);

CREATE TABLE IF NOT EXISTS matter_report_mentions (
  id bigserial PRIMARY KEY,
  matter_id bigint NOT NULL REFERENCES matters(id) ON DELETE CASCADE,
  report_id bigint NOT NULL REFERENCES public_reports(id) ON DELETE CASCADE,
  page integer NOT NULL,
  quote text NOT NULL,
  confidence real,
  source text NOT NULL DEFAULT 'name',
  hidden boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (matter_id, report_id, page)
);
CREATE INDEX IF NOT EXISTS matter_report_mentions_matter_idx ON matter_report_mentions (matter_id);

DROP TRIGGER IF EXISTS set_timestamp_public_reports ON public_reports;
CREATE TRIGGER set_timestamp_public_reports BEFORE UPDATE ON public_reports
  FOR EACH ROW EXECUTE PROCEDURE update_timestamp();

-- All three hold published City documents only: anyone may read, only the pipeline (service role) writes.
REVOKE ALL ON TABLE public_reports, public_report_pages, matter_report_mentions FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public_reports, public_report_pages, matter_report_mentions TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public_reports, public_report_pages, matter_report_mentions TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public_reports_id_seq, matter_report_mentions_id_seq TO service_role;
ALTER TABLE public_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public_report_pages ENABLE ROW LEVEL SECURITY;
ALTER TABLE matter_report_mentions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "public_reports public read" ON public_reports;
CREATE POLICY "public_reports public read" ON public_reports FOR SELECT TO anon, authenticated USING (true);
DROP POLICY IF EXISTS "public_report_pages public read" ON public_report_pages;
CREATE POLICY "public_report_pages public read" ON public_report_pages FOR SELECT TO anon, authenticated USING (true);
DROP POLICY IF EXISTS "matter_report_mentions public read" ON matter_report_mentions;
CREATE POLICY "matter_report_mentions public read" ON matter_report_mentions FOR SELECT TO anon, authenticated USING (NOT hidden);

-- Cached public pages refresh when these change (see 20261028054803_47_29_public_content_version.sql).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['public_reports', 'matter_report_mentions'] LOOP
    EXECUTE format('drop trigger if exists touch_public_content_version on public.%I', t);
    EXECUTE format('create trigger touch_public_content_version after insert or update or delete or truncate on public.%I '
                   'for each statement execute function public.touch_public_content_version()', t);
  END LOOP;
END $$;
