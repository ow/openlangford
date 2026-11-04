import { publicData } from "./public-data-cache.server";

/** Public aggregates now live at the edge, not in a DB row downloaded on every hit.
 * The five-minute TTL bounds corrections even when no meeting timestamp changes.
 * Errors are never stored; no background DB cache writes or freshness queries.
 */
export function cachedCompute<T>(key: string, compute: () => Promise<T>, { ttlSeconds = 300, shareWithSignedIn = false, changeGraceSeconds = 0 } = {}): Promise<T> {
  return publicData(key, compute, () => true, ttlSeconds, { shareWithSignedIn, changeGraceSeconds });
}

/** How long a heavy aggregate is kept after content changes: a backfill moves the change stamp every minute, and
 * rebuilding a full-table aggregate each time was the database's biggest load. Corrections show within this. */
export const HEAVY_CHANGE_GRACE_SECONDS = 900;

/** Aggregates that only change when a meeting is ingested; identical for every visitor. */
export const HOURLY_SHARED = { ttlSeconds: 3600, shareWithSignedIn: true, changeGraceSeconds: HEAVY_CHANGE_GRACE_SECONDS };
