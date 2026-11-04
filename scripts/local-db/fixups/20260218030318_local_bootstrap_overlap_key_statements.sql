-- LOCAL ONLY. bootstrap.sql already has key_statements.text_search; 20260218030319 adds it with a plain
-- ADD COLUMN. Drop the bootstrap copy so the migration adds it as on production.
ALTER TABLE public.key_statements DROP COLUMN IF EXISTS text_search;
