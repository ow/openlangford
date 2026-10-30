# ViewRoyal.ai — Web App

The public-facing web application for ViewRoyal.ai. Built with React Router 7 (SSR) and deployed to Cloudflare Workers.

## Setup

```bash
pnpm install
cp .env.example .env   # then fill in your keys
pnpm dev               # http://localhost:5173
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `SUPABASE_URL` | Supabase project URL (server-side) |
| `SUPABASE_SECRET_KEY` | Service role key (bypasses RLS) |
| `VITE_SUPABASE_URL` | Supabase URL (exposed to client) |
| `VITE_SUPABASE_PUBLISHABLE_DEFAULT_KEY` | Anon key (exposed to client) |
| `GEMINI_API_KEY` | Google Generative AI key (used when selected AI provider is `gemini`) |
| `OPENAI_API_KEY` | OpenAI key (query embeddings and AI generation when selected provider is `openai`) |
| `AI_PROVIDER` | Default AI provider: `gemini` or `openai` (defaults to `gemini`) |
| `RAG_AI_PROVIDER` / `RAG_AI_MODEL` | Optional override for RAG answers and follow-ups |
| `RERANK_AI_PROVIDER` / `RERANK_AI_MODEL` | Optional override for search-result reranking |
| `EXTRACTION_AI_PROVIDER` / `EXTRACTION_AI_MODEL` | Optional override for agenda intelligence extraction |
| `VIMEO_TOKEN` | Vimeo API token (optional, for direct API access) |
| `VIMEO_PROXY_URL` | Vimeo provider only: primary vimeo-proxy Worker URL (or `source_config.video_source.proxy_url`) |
| `VIMEO_PROXY_FALLBACK_URL` | Vimeo provider only: fallback proxy URL (or `source_config.video_source.proxy_fallback_url`) |
| `VIMEO_PROXY_API_KEY` | Auth key for primary proxy |
| `VIMEO_PROXY_FALLBACK_API_KEY` | Auth key for fallback proxy |
| `DOCUMENT_IMAGE_PUBLIC_BASE_URL` / `R2_PUBLIC_URL` | Public base URL for R2 document images; `document_images.r2_key` is appended to this |

## Scripts

| Command | Description |
|---------|-------------|
| `pnpm dev` | Start dev server with HMR |
| `pnpm build` | Production build |
| `pnpm start` | Start production server (Node) |
| `pnpm deploy` | Build and deploy to Cloudflare Workers |
| `pnpm typecheck` | Run TypeScript type checking |

## Stack

- **Framework:** React Router 7 (SSR) with React 19
- **Styling:** Tailwind CSS 4, shadcn/ui (Radix primitives)
- **Database:** Supabase (PostgreSQL + pgvector)
- **AI:** Google Gemini for RAG Q&A, OpenAI for vector embeddings
- **Video:** Vimeo with HLS playback via hls.js
- **Deployment:** Cloudflare Workers (primary), Docker (alternative)

## Project Structure

```
app/
  routes/          Route handlers (loaders, actions, components)
  components/      React components (ui/ for shadcn primitives)
  services/        Supabase queries and API integrations
  lib/             Utilities, Supabase clients, types
  hooks/           React hooks
  content/         Static markdown content
workers/
  app.ts           Cloudflare Workers entry point
```

### Public Markdown records

Meeting detail pages advertise `/meetings/{slug}/summary.md`; extracted document
pages advertise `/meetings/{slug}/documents/{id}/content.md` via HTML alternate
links. `/agents.md` describes scope and limitations. These resource loaders read
existing public database records through the anonymous client (never session or
admin clients), restrict documents to their parent public-ready meeting, and do
not call AI services. Overviews omit transcripts and cap source documents at 200;
extracted text caps sections at 500 and reports omissions. Official source links,
page ranges and AI/OCR uncertainty travel with the content.

Responses are `text/markdown`, publicly cacheable for five minutes, with an HTTP
canonical link to HTML and `X-Robots-Tag: noindex, follow`. Errors use `no-store`.
Markdown URLs are deliberately absent from the sitemap; canonical HTML stays the
indexed representation. Search and login HTML are crawlable with `noindex`;
protected and costly API routes retain their robots exclusions. Loading a search
URL never starts AI generation, including when a cached answer is missing.

Regression coverage: `pnpm test --run tests/routes/seo-metadata.test.ts tests/routes/public-markdown.test.ts`.

### Matter maps

The overview and individual matter location maps share `MattersMap`. MapLibre GL
renders OpenFreeMap's public Positron style (`https://tiles.openfreemap.org/styles/positron`);
no account, API key or metered tile provider is configured. Keep the style's
OpenFreeMap/OpenMapTiles/OpenStreetMap attribution visible. The library, CSS and
worker are bundled with the app. Availability depends on the public tile service.

Only the existing stored coordinates are used. Filters update a clustered GeoJSON
overlay; sidebar selection remains visible even within a cluster, and shared
locations expose all matter links. The keyboard-accessible location list works
without the canvas. Failed downloads or unavailable WebGL show a retry action
and expand that list rather than leaving a spinner indefinitely.
