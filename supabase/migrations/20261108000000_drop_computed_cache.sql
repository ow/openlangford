-- computed_cache held public aggregates in a database row. Nothing has written it since those moved to the
-- edge cache (publicData / cachedCompute), and the last reader/deleter (admin matters merge) is removed in the
-- same change. grep across apps/web, apps/pipeline, supabase, sql and scripts finds no other use.
DROP TABLE IF EXISTS computed_cache;
