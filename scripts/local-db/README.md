# Local development database

A local Supabase stack (Docker, via the Supabase CLI) with Open Langford's schema and a copy of the
public civic data, so the web app runs end to end without touching production.

Requires Docker, Node (for `npx supabase@3.0.0`), `uv`, and `pnpm install` done in the repo.

## Quick start

```bash
scripts/local-db/seed.sh --export --env-file .env --months all  # once: read-only export from production
scripts/local-db/reset.sh                                        # empty DB -> schema -> data -> local admin
scripts/local-db/dev.sh                                          # web app on http://localhost:5173
```

`dev.sh` passes extra arguments to `pnpm dev` (e.g. `scripts/local-db/dev.sh --port 5179`). It works from the
main checkout: its `.env` files only lend the OpenAI key (see below).

## Scripts

| Script | What it does |
| --- | --- |
| `start.sh` | Starts the stack (`supabase start --workdir scripts/local-db`); on a brand-new database also builds the schema, loads the data and creates the admin. Otherwise applies any new migrations. |
| `apply-migrations.sh` | Applies every `supabase/migrations` file in order, skipping ones already recorded in `supabase_migrations.schema_migrations`. Run it after pulling new migrations. |
| `seed.sh [--export --env-file F] [--months N\|all]` | Optionally re-exports public data from production (read-only), then loads it. Transcripts and document text cover the last N months (default 12, about 140 MB); `all` copies every meeting (about 250 MB), which the page checks and fix agent need for older topics. |
| `load-seed.sh` | Loads `data/` into the local database and checks every foreign key. |
| `reset.sh` | Rebuilds the local database from scratch (`supabase db reset`, then the above). |
| `create-admin.sh` | Creates/resets the local admin account. |
| `dev.sh` | Runs `pnpm dev` in `apps/web` against the local stack, and the Worker's five-minute cron jobs every five minutes (`LOCAL_CRON=false` to turn that off). |
| `cron.sh [--port P] [--cron "…"]` | Runs the Worker's scheduled jobs once on the dev server (reader report assessments, say). |
| `pipeline.sh <script.py> [args]` | Runs a pipeline command against the local stack: `pipeline.sh main.py --stage matter-summaries --target 310`, or a worker for the review bar's Fix (`pipeline.sh worker.py --job-types fix_page,find_matter_links`). |
| `check-parity.sh` | Diffs the local schema against production's (captured read-only by the last export). |

Stop the stack with `npx supabase@3.0.0 stop --workdir scripts/local-db` (add `--no-backup` to delete
the data volume). Studio: http://127.0.0.1:54323. Auth emails: http://127.0.0.1:54324.

## Logging in locally

`admin@langford.local` / `local-admin-password` (change with `LOCAL_ADMIN_EMAIL` / `LOCAL_ADMIN_PASSWORD`).
This account exists only in the local Docker stack. `dev.sh` puts it in `ADMIN_EMAILS` and
`create-admin.sh` also grants it the `admin` role in `user_roles`.

## How the web app is pointed at the local stack

Nothing is written to any `.env` file. `dev.sh` reads `supabase status -o env` and exports, for the dev
server process only: `SUPABASE_URL`, `VITE_SUPABASE_URL`, `SUPABASE_SECRET_KEY`,
`VITE_SUPABASE_PUBLISHABLE_DEFAULT_KEY`, `DATABASE_URL`, `ADMIN_EMAILS`, `CF_REMOTE_BINDINGS=false`, and
`CLOUDFLARE_INCLUDE_PROCESS_ENV=true` (so Worker `env` bindings also take the local values over
`wrangler.toml [vars]`). It also blanks the PostHog key and turns off AI usage logging, email dispatch and
Discord posts.

`apps/web/vite.config.ts` normally merges `wrangler.toml [vars]` < `process.env` < root `.env` < `apps/web/.env`,
so a `.env` file would override the local settings and point the dev server at production. `dev.sh` sets
`OPEN_LANGFORD_LOCAL_DB=1`, which makes Vite take only `OPENAI_API_KEY` from `.env` files, and
`CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false`, so Wrangler doesn't load them into the Worker either. It refuses
to run with an `apps/web/.dev.vars`, which Wrangler would still load.

AI features (Ask, AI search, page checks, the fix agent, report assessments) use `OPENAI_API_KEY` from your shell
or the checkout's `.env`, calling OpenAI directly (production goes through the Cloudflare AI Gateway).

`pipeline.sh` does the same for the pipeline, whose `load_dotenv()` never overrides a variable already set: it
points `SUPABASE_URL`, the keys and `DATABASE_URL` at the local stack and blanks everything that writes elsewhere
(R2 picture uploads, the Discord webhook, the email outbox), so a local run can't reach production.
Bylaw PDF downloads need Storage, which the local stack leaves out.

## Schema: migrations only

`supabase/migrations/` is the single schema source. Its first file, `<version>_baseline.sql`, is a dump of
production's public schema and builds everything on an empty database; later files change it. Migrations
from before the baseline are kept in `supabase/migrations_archive/` (see its README); the local database
never applies them.

`apply-migrations.sh` applies the files with `psql` (as `postgres`), loads pgvector first in each session, and
doesn't wrap files that use `CREATE INDEX CONCURRENTLY` or their own `BEGIN/COMMIT` in a transaction. The
result matches production's public schema (`check-parity.sh`), apart from migrations not yet merged.

This folder is a separate CLI workdir (`project_id = "langford-local"`) whose own `supabase/migrations`
folder is empty, so `supabase db push` for production never sees anything here.

A migration you are still editing is recorded once applied; after changing it, run `reset.sh`.

## Data: what's copied and what isn't

`export_public_data.py` reads production in one `REPEATABLE READ READ ONLY` transaction (no session
`SET`s) and writes `data/*.csv.gz` (gitignored, about 140 MB) plus `data/prod-schema.txt`.

- **Copied whole:** municipalities, organizations, people, memberships, council terms, elections,
  candidacies, meetings, attendance, agenda items, motions, votes, matters, matter links/merges/
  proposals/report mentions, key statements and votes, councillor stances/highlights, documents,
  extracted documents, document images, bylaws and chunks, source meetings, public reports, speaker
  aliases, meeting events and slug history, computed cache, and `pipeline_jobs`/`page_reviews` (read by
  /updates).
- **Sliced:** `transcript_segments` and `document_sections` for meetings in the last 12 months
  (`--months N`); `matter_evidence` rows for sections outside the slice are skipped, and
  `document_images.document_section_id` is blanked for them.
- **Private rows dropped:** `properties` where `hidden = true` and their `property_links`.
- **Columns blanked:** staff identities and notes (`reviewed_by`, `merged_by`, `decided_by`,
  `approved_by`, `pipeline_jobs.requested_by/locked_by/last_error`, page review notes).
- **Never copied:** auth users, `user_profiles`, `subscriptions`, `user_roles`, `api_keys`,
  `contact_messages`, all `email_*` tables, `search_results_cache`, `search_daily_usage`, `rag_traces`,
  `rag_feedback`, `staff_actions`, `ai_usage*`, `review_examples`, `review_guidance`, voice fingerprints
  and exemplars, `public_speaker_names`, `transcript_identity_evidence`, `pipeline_run_events`,
  `server_metrics`, `channel_posts`, `calendar_sync_state`, `data_reports`.

The export stops if production has a table that isn't in one of these lists, so a new table must be
classified before it's copied.
