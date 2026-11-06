# Archived migrations

These 113 files are every migration that existed before the schema baseline
(`../migrations/20261107000000_baseline.sql`). They were moved here with `git mv`, so history and blame
survive. The Supabase CLI only reads `supabase/migrations/`, so nothing here is ever applied.

Why they were retired:

- `sql/bootstrap.sql` plus the migrations did not build an empty database: two tables
  (`document_sections`, `extracted_documents`) were created in both, early files assumed objects that
  production had from before the migration folder existed, and several `CREATE TABLE`, `CREATE INDEX` and
  `CREATE POLICY` statements were not idempotent. The local database needed eight hand-written fixups.
- The baseline is a `pg_dump` of production's public schema, so it is correct by construction, and
  `supabase/migrations/` is now the single schema source.

Rules:

- History only. Do not edit, rename or re-apply these files, and do not copy them back into
  `supabase/migrations/` (the only reason to is the rollback in `../BASELINE-RUNBOOK.md`).
- Some SQL tests replay a single archived migration in isolation on stub tables
  (`apps/web/tests/services/*-database.test.ts`, `postgres-*.test.ts`, `sql/tests/`). That is why they read from here.
- `applied-versions-2026-11-05.txt` is production's applied-version list at the moment of the squash.
