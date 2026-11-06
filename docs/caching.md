# Caching in the web app

One story: **content stamp + shared tiers**. Whatever a visitor sees is cached at the edge, keyed by the
content stamp, so an ingest or correction shows within about a minute.

| Layer | Where | Key / TTL / invalidation |
|---|---|---|
| Content stamp | `workers/content-version.ts` | `public_content_version.changed_at` (DB triggers, at most once a minute); read once a minute per isolate. Part of every key below. |
| Edge page cache | `workers/public-meeting-cache.ts` | Rendered public pages, `.data` and `/api/meeting-text`, by URL + deploy + stamp; route TTL, stale up to a day. |
| `publicData` | `services/public-data-cache.server.ts` (21 call sites) | Cache API (per datacenter) then KV `PUBLIC_CACHE` (global). Key = caller key + schema + namespace; fresh while younger than TTL (default 300 s) and stamp current; stale served up to 24 h while refreshing. Anonymous visitors only, unless `shareWithSignedIn` (for values that never depend on who asks). |
| `cachedCompute` | `services/computed-cache.server.ts` (7 files) | Thin wrapper over `publicData` (always cacheable). `HOURLY_SHARED` for heavy aggregates. |
| Cache-Control | `lib/cache-policy.ts` | Named policies for every header the app sends (below). |
| Per-isolate memo (one) | `services/video/escribe-isi.server.ts` | The only allowed Map cache: an ISI mp4 URL is non-expiring and a pure function of the stored `video_url`, so there is nothing for the stamp to invalidate. 1 h, 200 entries, cleared by `/api/report-video-failure` in that isolate. |
| Vimeo stream row | `meetings.meta` (`services/video/vimeo.server.ts`) | The single tier for Vimeo. Shared by all isolates and the pipeline; 3 h; `/api/report-video-failure` clears it atomically (`invalidate_meeting_vimeo_cache`). KV/Cache API could not follow that invalidation across datacenters, so the DB row was kept. |

## Before and after (seven mechanisms)

Before: edge page cache; `publicData`; `cachedCompute`; content stamp; eight time-only per-isolate Maps
(`council-terms.ts` x2, `municipality.ts`, `site.ts` x2, `video/index.server.ts` setting, `vimeo.server.ts` mem tier,
`escribe-isi.server.ts`); the Vimeo DB-row tier (three tiers for one URL); the dead `computed_cache` table; 32 hand-written
Cache-Control strings.

After: the four stamp-aware layers; Cache-Control from `cache-policy.ts`; one documented memo (ISI); Vimeo has one tier
(its row). Folded into `publicData` (public rows, `shareWithSignedIn`, failures never stored): municipality, council terms,
council governance context (civic day in the key), video source setting, About stats; RSS notices lost their extra 5 min Map
over the existing 30 min `publicData` entry. Removed: `computed_cache` (code path in `admin-matters.tsx`, the
export-script table list, and the table via migration `20261108000000_drop_computed_cache.sql`).

## Cache-Control policies

`NO_STORE` (errors, 429s, streams), `PRIVATE` (`private, no-store`: per-visitor/guarded), `NO_CACHE` (SSE), `PUBLIC_API` (60 s),
`PUBLIC_SHORT` (300 s browser and edge), `PUBLIC_SIGNED_LINK` (3500 s, signed links valid 3600 s), `PUBLIC_DAY` (86400 s),
`PUBLIC_EDGE_DAY` (sitemaps), `PUBLIC_IMMUTABLE` (versioned share images), plus `publicMaxAge(n)` for Cache API entries.
No value was changed. `NO_STORE` and `PRIVATE` mean the same to every cache; both strings are kept so nothing observable changes.

## Behaviour changes

- Folded caches go from a 60 s per-isolate TTL to the shared 300 s TTL **plus** the content stamp, so a change to
  `municipalities`, `council_terms` or `memberships` (all stamped) shows within about a minute, as before, but is now shared across isolates.
- Outside the public origin (previews, localhost, scheduled workers) `publicData` bypasses, so those reads are no longer memoised for 60 s.
- Vimeo with no `meeting_id` (hand-made requests; the player always sends one) is not cached; `/api/video-source` is rate limited.
- Vimeo's in-isolate stream and thumbnail memo is gone; with a `meeting_id` it never saved a database read (it re-read the row to check invalidation).
- Pages that read the municipality may now report `HIT,STALE` in `X-Public-Data-Cache` (sitemap test adjusted).
