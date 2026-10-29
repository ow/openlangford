import type { HeadersArgs } from "react-router";

/**
 * Index loaders that degrade to an empty/partial page on a database error still answer 200.
 * They mark that answer `no-store` so the edge page cache never keeps it (workers/public-meeting-cache.ts).
 */
export const DEGRADED_HEADERS = { "Cache-Control": "no-store" } as const;

/** A route `headers` export that passes the loader's Cache-Control through (React Router otherwise keeps only cookies). */
export function forwardCacheControl({ loaderHeaders, parentHeaders }: HeadersArgs) {
  const headers = new Headers(parentHeaders);
  const cacheControl = loaderHeaders.get("Cache-Control");
  if (cacheControl) headers.set("Cache-Control", cacheControl);
  return headers;
}
