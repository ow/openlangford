# Open Langford

An open-source civic intelligence platform for the City of Langford, BC. Browse council meetings, watch video with synced transcripts, explore voting records, and ask AI-powered questions about local government decisions.

**Live at [openlangford.ca](https://openlangford.ca)** — a fork of [ViewRoyal.ai](https://github.com/kpeatt/viewroyal)

## Features

- **Meeting Explorer** -- Watch council meeting video with a synced sidebar showing agenda items, motions, and speaker-attributed transcripts
- **Unified Search** -- Perplexity-style single search page with auto-intent detection: keyword queries show hybrid-ranked results across all content types; natural language questions trigger streaming AI answers with inline citations
- **Hybrid Search** -- Reciprocal Rank Fusion combining vector similarity and full-text search across motions, key statements, document sections, and transcript segments
- **Voting Records** -- Source-backed explicit and reconstructed choices, with coverage labels and alignment analysis on validated complete ballots
- **AI Q&A** -- Multi-tool RAG agent with streaming answers, confidence indicators, conversation follow-ups (5-turn memory), and shareable cached answer URLs
- **Key Statement Extraction** -- AI-extracted typed statements (claims, proposals, objections, recommendations, financial impacts, public input) attributed to speakers
- **Council Profiles** -- Attendance stats, voting history, speaking time metrics (trend sparkline, topic breakdown, peer ranking), and AI-generated stance summaries per topic with confidence scoring and evidence quotes
- **Councillor Comparison** -- Side-by-side comparison of any two councillors: voting alignment percentage, per-topic stance agreement indicators, activity stats, and speaking time by topic
- **Bylaw & Matter Tracking** -- Follow issues as they move through council across multiple meetings
- **Property Pages** -- Every civic address and street council has dealt with (`/properties/2750-leigh-road`, `/properties/leigh-road`): all matters at the lot, mentions outside any matter, nearby matters by distance, and a map pin geocoded with BC's Address Geocoder
- **Written Submissions** -- Residents' letters from agenda packages, summarized and placed on the agenda item they're about (general letters go under the meeting's Correspondence or Public Participation item); unsure placements wait in `/admin/letters`
- **Election History** -- Past election results with candidate details
- **Speaker Identification** -- Diarized transcripts with speaker aliases resolved to real names via AI matching

## Architecture

```
apps/
  web/                    # React Router 7 web application (Cloudflare Workers)
  pipeline/               # Python ETL pipeline
  vimeo-proxy/            # Cloudflare Worker for Vimeo URL extraction
sql/
  bootstrap.sql           # Complete database schema (Supabase/PostgreSQL + pgvector)
```

**Data flow:** CivicWeb (PDFs/HTML) + Vimeo (video/audio) --> Python pipeline (5 phases) --> Supabase --> React Router web app

**Documentary validation:** Official minutes establish formal motion identity, outcomes, individual choices and per-vote attendance. Cached source-only refreshes retry when loaded validation code, candidate minutes, extracted facts, stored catalog identity, eligibility or policy evidence changes; they preserve summaries/transcripts and do not force paid profile generation. See the [source-validation cache contract](research/data-integrity/2026-10-18/source-validation-cache-contract.md) and [current data-repair checkpoint](research/data-integrity/2026-10-18/README.md). The archive remains incomplete; unsupported historical ballots stay held.

**Municipality context layer:** The root loader fetches the municipality row (currently hardcoded to slug `"view-royal"`), providing `name`, `short_name`, `website_url`, `rss_url`, `contact_email`, and `map_center` to all routes. Meta tags, service queries, AI prompts, and component copy are all driven by this data rather than hardcoded strings.

## Apps

- **[Web App](apps/web/)** -- React Router 7 frontend deployed to Cloudflare Workers. [README](apps/web/README.md)
- **[Data Pipeline](apps/pipeline/)** -- Python ETL pipeline for scraping, transcription, and AI-powered ingestion. [README](apps/pipeline/README.md)
- **[Vimeo Proxy](apps/vimeo-proxy/)** -- Cloudflare Worker for extracting direct video URLs from Vimeo. [README](apps/vimeo-proxy/README.md)

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Web app | [React Router 7](https://reactrouter.com/) (SSR on Cloudflare Workers), [Tailwind CSS 4](https://tailwindcss.com/), [shadcn/ui](https://ui.shadcn.com/) |
| Hosting | [Cloudflare Workers](https://workers.cloudflare.com/) |
| Database | [Supabase](https://supabase.com/) (PostgreSQL + pgvector + halfvec) |
| Pipeline | Python 3.13+, [uv](https://github.com/astral-sh/uv) |
| AI | OpenAI only: `gpt-6-luna` via the Responses API (extraction, summaries, RAG agent and answers) and the Decisions API (classification, linking, de-duplication) |
| Embeddings | OpenAI `text-embedding-3-small` (384-dim halfvec via Matryoshka truncation) |
| Transcription | Local MLX-based diarization on Apple Silicon |
| Video | Vimeo API + HLS playback |

## Database Schema

20 tables powered by Supabase (PostgreSQL + pgvector):

| Table | Purpose |
|-------|---------|
| `meetings` | Council meetings with status flags, video URLs, summaries |
| `agenda_items` | Per-meeting items with AI-generated summaries, debate summaries, discussion timestamps |
| `motions` | Formal motions with mover/seconder, results, vote tallies |
| `votes` | Individual council member votes on each motion |
| `transcript_segments` | Speaker-attributed transcript with timestamps and full-text search |
| `key_statements` | AI-extracted typed statements (claim/proposal/objection/recommendation/financial/public_input) |
| `meeting_speaker_aliases` | Maps diarization labels (Speaker_01) to real people |
| `matters` | Longitudinal topics tracked across meetings |
| `bylaws` + `bylaw_chunks` | Bylaw text split into searchable chunks |
| `documents` | Meeting PDFs (agendas, minutes, staff reports) |
| `people` | Council members, staff, public delegates |
| `organizations` + `memberships` | Governance structure and roles |
| `elections` + `candidacies` | Election history |
| `attendance` + `meeting_events` | Meeting participation tracking (source-evidenced rows carry `council-attendance/v1` notes) |
| `properties` + `property_links` | Civic addresses and streets, linked to the matters and agenda items that name them |
| `municipalities` | Municipality config: name, slug, website URL, RSS feed, map center, contact email |
| `topics` | Controlled taxonomy for agenda item classification |
| `councillor_stances` | AI-generated stance summaries per councillor per topic with position scores, confidence, and evidence |

**Search infrastructure:**
- `halfvec(384)` HNSW indexes on agenda_items, motions, matters, bylaws, bylaw_chunks, key_statements, meetings, documents
- `tsvector` GIN indexes for full-text search on transcript_segments, motions, agenda_items, matters, key_statements
- 3 `hybrid_search_*` RPC functions using Reciprocal Rank Fusion (vector + FTS)
- 7 `match_*` RPC functions for vector similarity search
- `search_results_cache` table for shareable AI answer URLs (30-day TTL)

## Getting Started

### Prerequisites

- [pnpm](https://pnpm.io/) (web app)
- [uv](https://github.com/astral-sh/uv) (pipeline)
- A [Supabase](https://supabase.com/) project

### Environment Setup

Create a `.env` file in the project root:

```env
# Database
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_KEY=your-anon-key
SUPABASE_SECRET_KEY=your-service-role-key
DATABASE_URL=postgresql://postgres:your-password@db.your-project.supabase.co:5432/postgres
SUPABASE_DB_PASSWORD=your-db-password

# Web app (also needs these in apps/web/.env or root .env)
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_PUBLISHABLE_DEFAULT_KEY=your-anon-key
ADMIN_EMAILS=you@example.com

# AI (OpenAI only) & Video
OPENAI_API_KEY=your-openai-key
AI_PROVIDER=openai
AI_MODEL=gpt-6-luna
DECISIONS_MODEL=
RAG_AI_PROVIDER=
RAG_AI_MODEL=
RERANK_AI_PROVIDER=
RERANK_AI_MODEL=
EXTRACTION_AI_PROVIDER=
EXTRACTION_AI_MODEL=
DOCUMENT_AI_PROVIDER=
DOCUMENT_AI_MODEL=
PROFILE_AI_PROVIDER=
PROFILE_AI_MODEL=
EMBEDDING_MODEL=text-embedding-3-small
EMBEDDING_DIMENSIONS=384
AI_USAGE_LOGGING=        # set to false to stop writing ai_usage rows
VIMEO_TOKEN=your-vimeo-api-token
```

### Database Setup

Apply the schema in your Supabase SQL Editor:

```sql
-- Run the contents of sql/bootstrap.sql
```

### Web App

```bash
cd apps/web
pnpm install
pnpm dev        # http://localhost:5173
pnpm deploy     # build + deploy to Cloudflare Workers
```

### Local preview (checking changes against real data)

Use this to see a web change with real data before it ships. The root `.env`
points at the **production** Supabase project, so a local preview reads (and,
if you submit a form, writes) live data.

**1. Work in a separate worktree, not the main checkout.** Other sessions may
be working in `~/Projects/viewroyal`.

```bash
git fetch origin main
git worktree add ../viewroyal-preview -b my-change origin/main
cd ../viewroyal-preview && pnpm install
ln -s ../viewroyal/.env .env    # in the worktree only: link to the real .env
```

> **Never overwrite `.env` in the main checkout.** `ln -sf ../viewroyal/.env .env`
> run *inside* `~/Projects/viewroyal` replaces the real file with a symlink to
> itself (this destroyed it once). Check first with `[ -f .env ] && [ ! -L .env ]`,
> and use `ln -s` without `-f` so an existing file makes the command fail.

**2. Start the dev server.** `wrangler.toml` declares a Cloudflare `[ai]`
binding, and `pnpm dev` opens a remote proxy for it, which needs a Cloudflare
login. Either:

- run `npx wrangler login` once (preferred), or
- for a quick local run, comment out the `[ai]` block in `apps/web/wrangler.toml`
  and create `apps/web/.dev.vars` with `AI_GATEWAY_ID=""` (it's gitignored).
  Without the empty gateway id, pages that touch AI fail with
  `Cannot read properties of undefined (reading 'gateway')`. Don't commit the
  `wrangler.toml` change.

```bash
cd apps/web
pnpm dev --port 5288 --strictPort
```

**3. Admin pages.** `/admin/*` needs a signed-in account listed in
`ADMIN_EMAILS`. Signing in at `http://localhost:5288/login` with your own
account should work (not yet verified; email sign-in links may point at the
live site). For automated screenshots (e.g. an agent without your login), add a temporary,
localhost-only route that calls the page's exported data function, and never
commit it:

```tsx
// apps/web/app/routes/zz-preview-admin-letters.tsx — LOCAL PREVIEW ONLY
import { getSupabaseAdminClient } from "../lib/supabase.server";
import { loadLetterQueue } from "./admin-letters";
export { default } from "./admin-letters";
export async function loader({ request }: { request: Request }) {
  if (new URL(request.url).hostname !== "localhost") throw new Response("", { status: 404 });
  return loadLetterQueue(getSupabaseAdminClient());
}
```

and register it in `app/routes.ts` with a `// PREVIEW` comment:
`route("zz-preview/admin/letters", "routes/zz-preview-admin-letters.tsx"), // PREVIEW`.
The merge, speaker-name and letter pages export their data loading
(`loadMergeQueue`, `loadNameQueue`, `loadLetterQueue`) for this; other admin
pages need the same small split before they can be previewed this way. The
preview route only has a loader, so its buttons can't write.

**4. Screenshots.** Playwright's Chromium is already installed under
`~/Library/Caches/ms-playwright`; point `executablePath` at it instead of
downloading another browser:

```js
import { chromium } from "playwright";
const browser = await chromium.launch({
  executablePath: `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
await page.goto("http://localhost:5288/zz-preview/admin/letters", { waitUntil: "networkidle" });
await page.screenshot({ path: "/tmp/preview.png", fullPage: true });
await browser.close();
```

**5. Before you commit, clean up** everything the preview added:

```bash
rm app/routes/zz-preview-*.tsx
git checkout app/routes.ts wrangler.toml    # drop the PREVIEW route and [ai] edit
rm .dev.vars                                # only if you created it
git status                                  # nothing preview-related left
```

**Scripts that change live data** (backfills, cleanups): run a dry run first,
print a sample of the changes, and save the rows you're about to change to a
backup file so they can be restored.

### Data Pipeline

See [Pipeline README](apps/pipeline/README.md) for full documentation.

Quick start:

```bash
cd apps/pipeline
uv run python main.py --download-audio
```

Internal queue/ops console:

```bash
pnpm dev:web            # http://localhost:5173
pnpm dev:worker         # processes queued /admin/pipeline jobs
pnpm dev:worker:once    # process at most one queued job
```

Open `/admin/pipeline` after signing in to discover source meetings, queue
document sync/ingest/extraction/embedding jobs, and inspect worker event logs.
Each job shows its estimated AI cost (tokens × list prices); the worker tags
every AI call with its job id (`ai_usage.pipeline_job_id`).

### Backfilling history from Glyphdex

The city's own archive only has Council meetings from 2016 and committees from
2023. The [Goldstream Public Record archive](https://gspr.emc2.build) (Glyphdex)
has Council back to 2008 and the standing committees (Planning, Zoning &
Affordable Housing; Transportation & Public Works; ...) for 2016–2022.
`pipeline/ingestion/glyphdex_import.py` downloads the original PDFs from its
public document API (checksum-verified, no search quota used) into the usual
archive layout and ingests them with our own pipeline:

```bash
cd apps/pipeline
# list what would be imported (meetings we already have are skipped)
uv run python -m pipeline.ingestion.glyphdex_import --body "Planning, Zoning" --from 2019-01-01 --to 2019-12-31 --dry-run
# import one meeting at a time through main.py
uv run python -m pipeline.ingestion.glyphdex_import --body "Committee" --from 2016-01-01 --to 2022-12-31 --ingest
# parallel: N workers, whole years per worker, post-ingest stages once at the end
uv run python -m pipeline.ingestion.glyphdex_import --body "Committee" --from 2016-01-01 --to 2022-12-31 --ingest --workers 4
```

- **Provenance:** each PDF gets a `.url` sidecar pointing at Glyphdex's archived
  copy (stored as the document's `source_url`), and the meeting folder gets
  `glyphdex.json` with Glyphdex ids, original filenames and SHA-256.
- **Parallel mode** holds the pipeline lock for the whole run (scheduled runs
  exit cleanly until it's done). Workers ingest meetings directly, record a
  meeting only once its row and agenda items exist, and delete a meeting they
  created if its ingest fails, so rerunning the same command picks up exactly
  what's missing. Progress: `archive/langford/reports/glyphdex-shard-N.log` and
  `.jsonl` (one line per meeting).
- **Standing committees** become their own organizations (slug
  `2019-07-08-planning-zoning-affordable-housing-committee`). Their motions are
  recommendations to Council and there are no validated committee ballot rules,
  so motions are held as unverified (`agenda_items.meta.unverified_motion_proposals`)
  rather than published.
- **Email alerts** are not triggered by backfills: the parallel workers skip the
  post-ingest alert hook, and the server only enqueues meetings on or after the
  alerts start date (see issue #58).

## RAG Q&A System

The unified search page (`/search`) combines keyword search and AI Q&A in a single interface:

**Keyword Mode** -- Hybrid search using Reciprocal Rank Fusion across motions, key statements, document sections, and transcript segments. Results ranked by combined vector similarity + full-text relevance.

**AI Answer Mode** -- Streaming RAG agent with 9 tools:
- `search_motions` -- Hybrid search on motions (vector + FTS)
- `search_agenda_items` -- Full-text search on agenda items
- `search_key_statements` -- Hybrid search on extracted statements
- `search_document_sections` -- Hybrid search on PDF document sections
- `search_matters` -- Vector search on longitudinal topics
- `search_transcript_segments` -- Full-text search on transcripts
- `get_statements_by_person` -- Find what a specific person said
- `get_voting_history` -- Look up voting records
- `get_current_date` -- Date context

**Conversation Continuity** -- Follow-up questions carry context from previous answers (capped at 5 turns). Topic changes auto-clear context. The model suggests follow-up chips after each answer.

**Shareable URLs** -- Completed AI answers are cached with short IDs (`/search?id=abc123`) for sharing without re-generation.

Embeddings are generated via OpenAI `text-embedding-3-small` at 384 dimensions (Matryoshka truncation), stored as `halfvec(384)` for 4x storage savings over full float32 vector(768).

## AI Architecture

All model calls go through one client per app, so models, retries, timeouts, house rules and usage logging live in one place:

- **Pipeline** -- `apps/pipeline/pipeline/ai/` (`from pipeline import ai`): text/JSON/PDF generation, the OpenAI Decisions API (`ai.decide`, choice/predicate questions) for classification and linking, embeddings and transcription. Models are set per stage (`EXTRACTION_AI_MODEL`, `DOCUMENT_AI_MODEL`, `PROFILE_AI_MODEL`, `DECISIONS_MODEL`, ... falling back to `AI_MODEL`, default `gpt-6-luna`).
- **Web** -- `apps/web/app/services/ai/` (`getAiClient()`): text, JSON (zod schemas), streaming answers and query embeddings for the RAG agent, reranking and agenda-item intelligence.
- **Embeddings** -- `text-embedding-3-small` at 384 dimensions everywhere; changing either means re-embedding.
- **House rules** -- prepended to every system prompt: never infer anyone's gender or use gendered pronouns unless the source states them.
- **Usage and failures** -- every call (success or failure) is recorded in the `ai_usage` table by both apps, without blocking the pipeline or delaying responses. `/admin/pipeline` shows the last 7/30 days by stage (calls, failures, tokens, estimated cost, p50/p95 latency) and the latest failures. Cost is estimated at read time from `apps/web/app/services/ai/pricing.ts`.
- **Stages** -- post-ingest enrichment (eSCRIBE attachments, document relinking, late-submission letters, written submissions, matter summaries, agenda alignment, public-participation summaries and names, matter images and links, properties and geocoding, councillor profiles, embeddings) is declared in `apps/pipeline/pipeline/stages.py` and runs in order after ingestion. Run one with `uv run python main.py --stage <name> [--target ID] [--since DATE] [--stale] [--dry-run]`; list them with `--stages`. `--stale` re-runs only items written by an older stage version.

## Adapting for Another Municipality

1. Add your municipality to the `municipalities` table in Supabase
2. Create a scraper class extending `BaseScraper` (or use an existing one if your source matches CivicWeb/Legistar/static HTML)
3. Register the scraper in `pipeline/scrapers/__init__.py`
4. Apply `sql/bootstrap.sql` to a fresh Supabase project
5. Run the pipeline: `uv run python main.py --municipality your-slug --download-audio`
6. Deploy the web app with your Supabase credentials

## License

[MIT](LICENSE)
