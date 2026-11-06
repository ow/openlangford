# Serving images from a CDN-cached domain

Report pictures, meeting posters and share cards live in the R2 bucket `langford` (under the key prefix `viewroyal-document-images/`; see the cause below)
(`R2_BUCKET_NAME` in the pipeline). The site currently links to them through the bucket's `r2.dev`
URL (`DOCUMENT_IMAGE_PUBLIC_BASE_URL` in `apps/web/wrangler.toml`). That URL is for development: it is
rate-limited and bypasses Cloudflare's CDN (no `cf-cache-status`, ~500 ms first byte). A custom domain on
the bucket fixes both.

## How the code handles it

- `apps/web/app/lib/image-url.ts` is the only place that reads the base URL (`imageBaseUrl()`).
  `DOCUMENT_IMAGE_CDN_BASE_URL` wins when set, then `DOCUMENT_IMAGE_PUBLIC_BASE_URL`, then `R2_PUBLIC_URL`.
- Report images are built from the stored `r2_key` (`imageUrlForKey`), so they move with the base.
- Posters, share cards and title cards are stored as absolute `r2.dev` URLs in `meetings.meta.poster.url`,
  `meta.share_card.url` and `meta.title_card.url` (written by `pipeline/video/posters.py`, one per meeting
  with a recording). `rewriteImageUrl` swaps only the host of any `*.r2.dev` URL for the configured base's host
  (the path, including the `viewroyal-document-images/` prefix, is kept) at read time (meeting
  page, meeting explorer, email digests), so no data migration is needed and old rows keep working.
- Nothing changes until the owner sets the new variable.

## Known quirk: doubled bucket name

Objects are stored with `viewroyal-document-images/` as a key prefix (checked live: `meeting-posters/239/2894-v3.webp`
returns 200 only under `/viewroyal-document-images/`). Confirmed cause: the account has one bucket, `langford`, and the pipeline's `R2_ENDPOINT_URL` ends
with the bucket name, so boto3's path-style PUT lands at `<bucket>/<bucket>/<key>`. That is why every base URL carries
the prefix. Later cleanup: fix the endpoint, move the objects, then drop the prefix from the base and the stored URLs.

## Owner steps

1. Attach the domain to the bucket (creates the DNS record and certificate; the zone must be on this account):
   ```bash
   wrangler r2 bucket domain add langford --domain images.openlangford.ca --zone-id <openlangford.ca zone id>
   wrangler r2 bucket domain list langford   # wait for the status to show active
   ```
   This adds a proxied DNS record for `images` in the zone. The domain serves the bucket root, and the objects
   are stored under a `viewroyal-document-images/` key prefix, so URLs are
   `https://images.openlangford.ca/viewroyal-document-images/<key>`.
2. Caching. R2 custom domains are served through Cloudflare's CDN. Poster and share-card objects are uploaded with
   `Cache-Control: public, max-age=31536000, immutable`; extracted report images (`image_extractor.py`) are
   uploaded without one. Add a Cache Rule (Caching > Cache Rules) so all of them cache well:
   - If: Hostname equals `images.openlangford.ca`
   - Then: Eligible for cache; Edge TTL: 1 year; Browser TTL: 1 year.
   Keys are versioned or per-document, so long TTLs are safe.
3. Point the site at it. In `apps/web/wrangler.toml` uncomment
   `DOCUMENT_IMAGE_CDN_BASE_URL = "https://images.openlangford.ca/viewroyal-document-images"` and merge to `main`.
   (If a Cloudflare dashboard build variable is used for build-time vars, set it there too.)
4. Optional, so new pipeline writes store CDN URLs directly: set
   `DOCUMENT_IMAGE_PUBLIC_BASE_URL=https://images.openlangford.ca/viewroyal-document-images` in the pipeline environment (read by
   `posters.py`). The web rewrite makes this unnecessary for display.

## Verify

```bash
curl -sI https://images.openlangford.ca/viewroyal-document-images/<a key, e.g. documents/27/311/90.webp> | grep -iE "^(HTTP|cf-cache-status|cache-control|age)"
# first request: cf-cache-status: MISS; repeat: cf-cache-status: HIT
```
Then open a meeting page and confirm the hero image and `og:image` meta tag point at `images.openlangford.ca`.

## Status (2026-11-06)

`images.openlangford.ca` was attached to the `langford` bucket from this session (`wrangler r2 bucket domain add langford ...`).
Until `wrangler r2 bucket domain list langford` shows `ownership_status: active` and `ssl_status: active`, leave
`DOCUMENT_IMAGE_CDN_BASE_URL` commented out in `wrangler.toml`.
