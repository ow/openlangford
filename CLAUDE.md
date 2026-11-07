# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Open Langford (openlangford.ca) — a civic intelligence platform for the City of Langford, BC, forked from Kyle's open-source ViewRoyal.ai. A Python ETL pipeline scrapes council meeting documents, diarizes video, and ingests into Supabase. A React Router 7 web app serves it on Cloudflare Workers.

## Monorepo Structure

```
apps/web/              # React Router 7 web app (Cloudflare Workers)
apps/vimeo-proxy/      # Cloudflare Worker + Puppeteer for Vimeo URL extraction
apps/pipeline/         # Python ETL pipeline
  pipeline/            #   Core package (scrapers, ingestion, video, diarization)
  tests/               #   Python tests (pytest)
  scripts/             #   One-off maintenance/analysis scripts (gitignored)
  main.py              #   Pipeline entry point
supabase/migrations/    # Database schema: baseline + later migrations (the only schema source)
sql/                   # Hand-run SQL, corrections and SQL tests
```

## Commands

### Web App (`apps/web/`)
```bash
pnpm dev              # Vite dev server (localhost:5173); refuses to start while one is running for this checkout (use it, or kill the pid it prints)
pnpm build            # Build for Cloudflare Workers
pnpm deploy           # Manual build + wrangler deploy: emergencies only, with the owner's OK (see Deploying)
pnpm typecheck        # React Router typegen + tsc
```

### Python Pipeline (`apps/pipeline/`)
```bash
uv run python main.py                    # Full 5-phase pipeline
uv run python main.py --target 42        # Single meeting by ID
uv run python main.py --ingest-only      # Phase 4 only
uv run python main.py --embed-only       # Phase 5 only
uv run python main.py --rediarize        # Re-diarize from cached transcripts
uv run python main.py --stages          # List post-ingest/enrichment stages
uv run python main.py --stage matter-summaries --stale --dry-run  # One stage, stale items only
uv run pytest                            # All tests
uv run pytest tests/core/test_parser.py -v  # Single test file
```
All pipeline commands run from `apps/pipeline/` (where `pyproject.toml` and `pytest.ini` live).

## Deploying

Production (openlangford.ca) deploys automatically when commits land on `main`: Cloudflare builds and deploys every push. To ship, `git pull --rebase origin main`, then `git push origin main` (if SSH to GitHub times out, push over HTTPS with the gh credentials).
- Never run `wrangler deploy` / `pnpm deploy` yourself, even if wrangler is logged in. A manual deploy skips the normal build, uses whatever is in your local `.env`, and can ship code that isn't on `main`. Only do it if the owner explicitly asks.
- Don't sit in a loop waiting for a deploy to go live. Push, carry on, and check production once later.
- Migrations in `supabase/migrations/` apply automatically on merge too (see Database Gotchas).

## Tech Stack

- **Frontend**: React 19, React Router 7 (SSR), Tailwind CSS 4, shadcn/ui + Radix UI, lucide-react
- **Backend**: Cloudflare Workers (wrangler), Supabase (PostgreSQL + pgvector)
- **AI**: OpenAI only — `gpt-6-luna` (Responses API + Decisions API), `text-embedding-3-small` @ 384 embeddings
- **Pipeline**: Python 3.13+, uv package manager, MLX diarization (Apple Silicon)
- **Build**: pnpm workspaces, Vite 7, TypeScript 5.9

## Architecture

### Data Flow
```
Meeting documents (eSCRIBE / CivicWeb) + meeting video (video provider) → Python Pipeline (5 phases) → Supabase → Web App
```

Pipeline phases: scrape → download audio → diarize → AI refine + ingest → embed → post-ingest stages (registry)

### Web App Routing
Flat file routes in `apps/web/app/routes/`. Server loaders fetch from Supabase, components render with SSR. API routes (`api.search.tsx`, `api.video-source.ts`) handle server actions.

### Video providers
Each municipality's meeting video comes from one provider, set by `municipalities.source_config.video_source.type` (`isilive` = eSCRIBE/ISI Live for Langford, `vimeo` upstream). When unset, or when a URL belongs to another provider, the provider is detected from the URL host.
- **Web** `app/services/video/`: `catalog.ts` (browser-safe: label, deep link, privacy wording, URL ownership), `index.server.ts` (registry, setting lookup, `resolveVideoSource`), one `*.server.ts` per provider (`vimeo.server.ts` incl. the `apps/vimeo-proxy` worker fallback; `escribe-isi.server.ts`). `/api/video-source` resolves a stored `video_url` to a playable stream (`/api/vimeo-url` is an alias); `/api/report-video-failure` asks the provider to drop its cached stream. Pages use `hooks/useMeetingMedia.ts`.
- **Pipeline** `pipeline/video/providers.py`: the same registry in Python (`get_video_client`, `resolve_media_url`).

### Supabase Client Initialization
Three clients exist — use the right one:
- **Browser** (`app/lib/supabase.ts`): `createBrowserClient` — for React components. Lazy-inits only in browser to avoid breaking Workers SSR.
- **Server with auth** (`app/lib/supabase.server.ts`): `createSupabaseServerClient(request, responseHeaders)` — for loaders/actions needing user context.
- **Server admin** (`app/lib/supabase.server.ts`): `getSupabaseAdminClient()` — bypasses RLS, cached singleton.

### Service Layer
`app/services/*.ts` contains typed Supabase query functions. Loaders call these with the appropriate client.

### RAG Q&A
`app/services/rag.server.ts` — ReAct agent (structured-output tool decisions) over hybrid search, then a streamed answer with numbered citations.

### AI layer (OpenAI only)
Every model call goes through one client per app; never call a provider SDK directly.
- **Pipeline** `pipeline/ai/` (`from pipeline import ai`): `ai.text` / `ai.json` (pydantic schema) / `ai.pdf` / `ai.decide` + `ai.decide_many` (Decisions API: `ai.choice` / `ai.predicate` questions, used for classification/linking/dedup) / `ai.embed` / `ai.transcribe`. Per-stage config in `pipeline/ai/config.py`: `<STAGE>_AI_MODEL` → `AI_MODEL` → `gpt-6-luna`; `DECISIONS_MODEL`; stages: extraction, document, profile, rag, rerank, decisions, embedding, asr, plus review and writing (public summaries and highlights), which default to `gpt-6.1-terra` (`REVIEW_AI_MODEL`, `WRITING_AI_MODEL`). Model-written text (summaries, key facts) is never a source of facts: see `pipeline/ingestion/record_sources.py`.
- **Web** `app/services/ai/` (`getAiClient()`): `text` / `json` (zod → strict JSON Schema) / `stream` / `embed`, plus `embedQuery`. Stages agent/answer/followups (`RAG_AI_MODEL`), rerank, extraction, falling back to `AI_MODEL`. Plus review (`REVIEW_AI_MODEL`) and writing (`WRITING_AI_MODEL`, topic summaries the fix agent rewrites).
- **Embeddings**: `text-embedding-3-small` @ 384 dims (`EMBEDDING_MODEL`/`EMBEDDING_DIMENSIONS`) — must match stored vectors; changing it means re-embedding.
- **House rules** live in the clients (`HOUSE_RULES`, prepended to every system prompt): never infer gender; no he/she unless the source states pronouns. Clients also own retries (429/5xx/network/timeout), timeouts and usage reporting.
- **Usage/failure logging**: one row per call in `ai_usage` (source pipeline|web, stage, model, tokens, latency, ok/error, job, meeting_id, request_id). Pipeline: `pipeline/ai/usage_sink.py` batches inserts in a background thread (installed by `main.py`/`worker.py`; `usage_context(job=..., meeting_id=...)` labels rows). Web: `services/ai/usage-sink.server.ts`, fire-and-forget via `ctx.waitUntil` (request context set in `workers/app.ts`). `AI_USAGE_LOGGING=false` disables. Cost is estimated at read time from `services/ai/pricing.ts` (Decisions API: $0.10/M input, no output charge); see the AI usage section of `/admin/pipeline`.

### Page review fixes
The review bar's fix agent (`services/page-fix.server.ts`) carries out every fix in its own request, including moves, merges and the summary rewrite (`services/topic-summaries.server.ts`, a port of the pipeline's `matter_summaries.py`). Only re-filing an item through the ingest matcher goes to the quick worker as a `fix_page` job. Both summary writers read `shared/prompts/topic-summaries.json`: change prompts there. See `docs/page-review-fixes.md`.

### Email alerts
The 5-minute cron (`workers/email-enqueue.ts`) asks the `send-alerts` Edge function (deployed by hand, not CI) to queue post-meeting digests and, with `mode: "agenda"`, before-meeting agenda previews; both match subscribers through the SQL `alert_subscription_matches`. See `docs/agenda-alerts.md`.

### Pipeline stages
`pipeline/stages.py` registers every post-ingest/enrichment stage (name, function, `post_ingest`|`backfill_only`, scope, version, dependencies) in run order. After ingestion the orchestrator runs the `post_ingest` stages in order, each isolated. Run one on demand with `main.py --stage NAME [--target ID] [--since DATE] [--stale] [--force] [--dry-run]` (`--stages` lists them). Stages that write AI output stamp a version (`matters.meta.summary_version`, `matters.meta.images_version`, `agenda_items.meta.participation_version`, `agenda_items.meta.participation_minutes_version` for the transcript-less `participation-from-minutes` stage); bump the module's `*_VERSION` after a prompt change and run `--stage X --stale`. Add new enrichment steps to the registry, not as new one-off flags.

## Writing style

All public text (page copy, notes stored in the database, and AI prompts that write summaries, headlines or descriptions) follows `docs/writing-style.md`: plain language for residents, outcomes first, no codes or database words ("matters", "records"), provenance in `meta` not visible text. Read it before writing or changing any of these.

## Environment Variables

Public vars live in `wrangler.toml [vars]` (parsed at build time by `vite.config.ts`). Secrets must be set as:
- **Cloudflare Worker secrets** (runtime): `SUPABASE_SECRET_KEY`, `OPENAI_API_KEY`, `VIMEO_PROXY_API_KEY`
- **Cloudflare Build Configuration variables** (build-time): `SUPABASE_SECRET_KEY`, `OPENAI_API_KEY`
- **Local `.env`** files (not committed): loaded by Vite's `loadEnv` from both root and `apps/web/`

The `vite.config.ts` `define` block inlines all env vars at build time since `process.env` doesn't exist in Cloudflare Workers. Priority: wrangler.toml vars < process.env < root .env < local .env.

## Database Gotchas

- `agenda_items.neighborhood` exists in the live database (verified October 18, 2026); its values may be null.
- `apps/web/app/lib/database.types.ts` is generated from the live schema and is the source of truth for tables, columns, embeds and RPC signatures; the Supabase clients are typed with it (`TypedSupabaseClient`), so a wrong column in a `.select()` literal fails `pnpm typecheck`. Regenerate after a migration is applied with `pnpm db:types` in `apps/web/` (needs `DATABASE_URL`; CI checks it is fresh). `app/lib/types.ts` is hand-written and can run ahead of the schema: don't trust it for what exists in the database.
- `supabase/migrations/` is the only schema source (`sql/bootstrap.sql` is gone). Its first file, `20261107000000_baseline.sql`, is a dump of production's public schema as of 2026-11-05 and stands in for the 113 earlier migrations, which live in `supabase/migrations_archive/` (history only: never edit or re-apply them; a few SQL tests replay individual files from there). The one-time production history repair is in `supabase/BASELINE-RUNBOOK.md`. A fresh database is `scripts/local-db/apply-migrations.sh`, nothing else. Uses pgvector (installed in `public`) for embeddings.
- Migrations live in `supabase/migrations/` as `<UTC timestamp>_<name>.sql` (create with `npx supabase migration new <name>`). Merging to main applies new ones to production via `.github/workflows/supabase-migrations.yml` (`supabase db push`, recorded in `supabase_migrations.schema_migrations`), so a migration must be safe to run against live data the moment it merges. Never apply migrations by hand anymore; never rename an applied migration file.
- When a table starts storing a new kind of data, re-check its RLS policies and grants in the same change. Why: `search_results_cache` kept the public-read policy it got when it held only public search results, and later stored residents' AI questions, which anyone with the publishable key could then list.
- `DATABASE_URL` goes through Supavisor's transaction-mode pooler (port 6543): a session-level `SET` sticks to whichever pooled backend ran it and is handed to other clients. Never run `SET default_transaction_read_only = on` (or any plain `SET`) on it; for a read-only check send one transaction, e.g. `psql "$DATABASE_URL" -c "begin read only; select ...; commit"`. Why: on 2026-10-30 a leaked read-only backend failed 18 pipeline writes. Pipeline writes over this URL go through `pipeline/db.py` `run_write`.
- `matters.content_updated_at` is the "something a reader sees on the topic page changed" stamp: triggers set it when a visible `matters` field or one of the `meta` keys the page reads (listed in `stamp_matter_content()`) changes, and when entries move in or out (`agenda_items.matter_id`, shown rows of `matter_links`, `matter_evidence`, `matter_report_mentions`). Version stamps and review bookkeeping in `meta` don't count. If the page starts showing a new `meta` key or table, add it to the triggers in a migration.
- `updated_at` (on `matters` and every other table) is a write stamp bumped by any UPDATE, including bulk backfills: never use it for freshness (sitemap lastmod, `dateModified`, "Updated" lines).
- `properties.hidden` marks lots known only as a resident's home address (from public input). They have no page and must never be listed. The web reads properties with the admin client, which bypasses RLS, so every `properties` query (and embedded `properties(...)`) filters out hidden rows. The pipeline's properties stage keeps the flag current through `refresh_property_privacy()`.

## Known Issues

- Pre-existing type error in `voice-fingerprints.tsx` line 404 — ignore it.
- `wrangler deploy` overwrites dashboard-set vars with `wrangler.toml` — all public vars must be in `[vars]` section.
- `separator.tsx` sourcemap warning during build is harmless.
