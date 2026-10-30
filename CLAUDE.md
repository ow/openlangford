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
sql/                   # Database bootstrap (bootstrap.sql)
```

## Commands

### Web App (`apps/web/`)
```bash
pnpm dev              # Vite dev server (localhost:5173)
pnpm build            # Build for Cloudflare Workers
pnpm deploy           # Build + wrangler deploy
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

## Tech Stack

- **Frontend**: React 19, React Router 7 (SSR), Tailwind CSS 4, shadcn/ui + Radix UI, lucide-react
- **Backend**: Cloudflare Workers (wrangler), Supabase (PostgreSQL + pgvector)
- **AI**: OpenAI only — `gpt-6-luna` (Responses API + Decisions API), `text-embedding-3-small` @ 384 embeddings
- **Pipeline**: Python 3.13+, uv package manager, MLX diarization (Apple Silicon)
- **Build**: pnpm workspaces, Vite 7, TypeScript 5.9

## Architecture

### Data Flow
```
CivicWeb PDFs + Vimeo Video → Python Pipeline (5 phases) → Supabase → Web App
```

Pipeline phases: scrape → download audio → diarize → AI refine + ingest → embed → post-ingest stages (registry)

### Web App Routing
Flat file routes in `apps/web/app/routes/`. Server loaders fetch from Supabase, components render with SSR. API routes (`api.ask.tsx`, `api.vimeo-url.ts`) handle server actions.

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
- **Pipeline** `pipeline/ai/` (`from pipeline import ai`): `ai.text` / `ai.json` (pydantic schema) / `ai.pdf` / `ai.decide` + `ai.decide_many` (Decisions API: `ai.choice` / `ai.predicate` questions, used for classification/linking/dedup) / `ai.embed` / `ai.transcribe`. Per-stage config in `pipeline/ai/config.py`: `<STAGE>_AI_MODEL` → `AI_MODEL` → `gpt-6-luna`; `DECISIONS_MODEL`; stages: extraction, document, profile, rag, rerank, decisions, embedding, asr.
- **Web** `app/services/ai/` (`getAiClient()`): `text` / `json` (zod → strict JSON Schema) / `stream` / `embed`, plus `embedQuery`. Stages agent/answer/followups (`RAG_AI_MODEL`), rerank, extraction, falling back to `AI_MODEL`.
- **Embeddings**: `text-embedding-3-small` @ 384 dims (`EMBEDDING_MODEL`/`EMBEDDING_DIMENSIONS`) — must match stored vectors; changing it means re-embedding.
- **House rules** live in the clients (`HOUSE_RULES`, prepended to every system prompt): never infer gender; no he/she unless the source states pronouns. Clients also own retries (429/5xx/network/timeout), timeouts and usage reporting.
- **Usage/failure logging**: one row per call in `ai_usage` (source pipeline|web, stage, model, tokens, latency, ok/error, job, meeting_id, request_id). Pipeline: `pipeline/ai/usage_sink.py` batches inserts in a background thread (installed by `main.py`/`worker.py`; `usage_context(job=..., meeting_id=...)` labels rows). Web: `services/ai/usage-sink.server.ts`, fire-and-forget via `ctx.waitUntil` (request context set in `workers/app.ts`). `AI_USAGE_LOGGING=false` disables. Cost is estimated at read time from `services/ai/pricing.ts` (Decisions API: $0.10/M input, no output charge); see the AI usage section of `/admin/pipeline`.

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
- Always verify columns exist in the actual database before adding them to `.select()` strings — TypeScript types in `app/lib/types.ts` can be aspirational/ahead of the schema.
- Schema is bootstrapped from `sql/bootstrap.sql`. Uses pgvector extension for embeddings.
- Migrations live in `supabase/migrations/` as `<UTC timestamp>_<name>.sql` (create with `npx supabase migration new <name>`). Merging to main applies new ones to production via `.github/workflows/supabase-migrations.yml` (`supabase db push`, recorded in `supabase_migrations.schema_migrations`), so a migration must be safe to run against live data the moment it merges. Never apply migrations by hand anymore; never rename an applied migration file.

## Known Issues

- Pre-existing type error in `voice-fingerprints.tsx` line 404 — ignore it.
- `wrangler deploy` overwrites dashboard-set vars with `wrangler.toml` — all public vars must be in `[vars]` section.
- `separator.tsx` sourcemap warning during build is harmless.
