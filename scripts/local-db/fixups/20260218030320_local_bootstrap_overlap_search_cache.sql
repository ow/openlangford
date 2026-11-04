-- LOCAL ONLY. bootstrap.sql already has search_results_cache; 20260218030321 creates it with a plain
-- CREATE TABLE. Drop the bootstrap copy so the migration creates it as on production.
DROP TABLE IF EXISTS public.search_results_cache CASCADE;
