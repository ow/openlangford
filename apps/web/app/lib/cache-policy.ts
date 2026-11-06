/**
 * Every Cache-Control value the app sends, by name. Routes import a policy instead of
 * writing the header by hand, so what each response promises browsers and shared caches
 * is reviewable in one place. (Server-side cache tiers are described in docs/caching.md.)
 */

/** Never stored anywhere: errors, rate-limit replies and live streams. */
export const NO_STORE = "no-store";
/** Per-visitor or guarded responses. Equivalent to no-store for every cache; the name says why it is sent. */
export const PRIVATE = "private, no-store";
/** Server-sent event streams: a cache may keep nothing without revalidating. */
export const NO_CACHE = "no-cache";
/** Small public JSON that may be a minute old (quick search). */
export const PUBLIC_API = "public, max-age=60";
/** Public text and redirects that may be five minutes old, in browsers and at the edge alike. */
export const PUBLIC_SHORT = "public, max-age=300, s-maxage=300";
/** Redirect to a signed storage link that is valid for an hour: expire it a little earlier. */
export const PUBLIC_SIGNED_LINK = "public, max-age=3500";
/** Public and stable for a day (permanent redirects, unversioned share images). */
export const PUBLIC_DAY = "public, max-age=86400";
/** Sitemaps: browsers recheck hourly, the edge keeps them a day. */
export const PUBLIC_EDGE_DAY = "public, max-age=3600, s-maxage=86400";
/** Content-addressed files whose URL changes when the content does. */
export const PUBLIC_IMMUTABLE = "public, max-age=31536000, immutable";

/** `public, max-age=N` for an entry in a server-side cache store (Cache API), where N is how long the store may keep it. */
export function publicMaxAge(seconds: number): string {
  return `public, max-age=${Math.max(1, Math.ceil(seconds))}`;
}
