# SQL

The database schema is in `../supabase/migrations/` (the only schema source; see `../supabase/BASELINE-RUNBOOK.md`).
Requires the `pgvector` extension for semantic search support.

This folder holds hand-run SQL (`add_*.sql`, `corrections/`, `motions_full_text_search_*.sql`) and the
SQL tests in `tests/`. Anything that changes the schema belongs in a migration, not here.
