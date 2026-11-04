-- LOCAL ONLY. Runs after every migration (idempotent): removes local placeholders and lines the
-- local schema up with production where production's history happened outside supabase/migrations.
-- scripts/local-db/check-parity.sh compares the result with production.

-- Placeholders from fixups/ that production doesn't have.
DROP TRIGGER IF EXISTS update_key_votes_updated_at ON public.key_votes;
DROP FUNCTION IF EXISTS public.update_updated_at_column();
DROP FUNCTION IF EXISTS public.find_matters_near(double precision, double precision, integer, integer);

-- 20260313051431_39_key_votes_table's indexes never reached production.
DROP INDEX IF EXISTS public.idx_key_votes_person_id;
DROP INDEX IF EXISTS public.idx_key_votes_composite_score;

-- Production has bootstrap.sql's document_section links that the fixups dropped to let the
-- document migrations run (fixups/20260217162434_local_bootstrap_overlap_documents.sql).
ALTER TABLE public.document_images ADD COLUMN IF NOT EXISTS document_section_id bigint;
DO $$ BEGIN
  ALTER TABLE public.document_images ADD CONSTRAINT document_images_document_section_id_fkey
    FOREIGN KEY (document_section_id) REFERENCES public.document_sections(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN null; END $$;
CREATE INDEX IF NOT EXISTS idx_document_images_section ON public.document_images (document_section_id);
DO $$ BEGIN
  ALTER TABLE public.matter_evidence ADD CONSTRAINT matter_evidence_document_section_id_fkey
    FOREIGN KEY (document_section_id) REFERENCES public.document_sections(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- Production's slug indexes are partial (slug IS NOT NULL); bootstrap.sql's are not.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['bylaws', 'matters', 'meetings'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'idx_' || t || '_slug_muni'
                   AND indexdef LIKE '%WHERE%') THEN
      EXECUTE format('DROP INDEX IF EXISTS public.%I', 'idx_' || t || '_slug_muni');
      EXECUTE format('CREATE UNIQUE INDEX %I ON public.%I (slug, municipality_id) WHERE slug IS NOT NULL',
                     'idx_' || t || '_slug_muni', t);
    END IF;
  END LOOP;
END $$;
