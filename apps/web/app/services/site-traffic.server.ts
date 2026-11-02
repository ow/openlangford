/**
 * Visitors and page views for the admin overview, read from PostHog's query API.
 *
 * Needs the POSTHOG_PERSONAL_API_KEY Worker secret (a personal key with query:read on the project)
 * and POSTHOG_PROJECT_ID from wrangler.toml [vars]. Without them the overview says traffic isn't connected.
 *
 * Visitors are distinct random ids (components/posthog-provider.tsx keeps one in a cookie for a
 * year). Before November 2026 the id lasted only for a browser tab, so older days count tabs.
 */

const POSTHOG_APP_HOST = "https://us.posthog.com";
/** Traffic doesn't need to be live: a stored read is used for 30 minutes, then refreshed in the background while
 * the stored one (up to a day old) is still shown. Only with nothing stored does a page wait for PostHog. */
const FRESH_MS = 30 * 60_000;
const STALE_MS = 24 * 60 * 60_000;
const DAYS = 30;

export type DailyPoint = { day: string; value: number };

export type SiteTraffic =
  | { available: false; reason: "not_configured" }
  /** status is PostHog's HTTP status when it refused the request, null for timeouts and network errors. */
  | { available: false; reason: "error"; status: number | null }
  | {
      available: true;
      /** When PostHog was read (ISO). */
      asOf: string;
      visitors: DailyPoint[];
      views: DailyPoint[];
      visitors7: number;
      visitorsPrev7: number;
      views7: number;
      viewsPrev7: number;
      topPages: { label: string; value: number }[];
      referrers: { label: string; value: number }[];
    };

type Stored = { at: number; value: SiteTraffic };
type Kv = { get(key: string, type: "json"): Promise<unknown>; put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> };

let memory: { key: string; stored: Stored } | null = null;
let refreshing: Promise<SiteTraffic> | null = null;

class PostHogError extends Error {
  constructor(readonly status: number) {
    super(`PostHog query failed (${status})`);
  }
}

async function hogql(projectId: string, apiKey: string, query: string, timeoutMs: number): Promise<any[][]> {
  const response = await fetch(`${POSTHOG_APP_HOST}/api/projects/${encodeURIComponent(projectId)}/query/`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: { kind: "HogQLQuery", query } }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new PostHogError(response.status);
  const body = (await response.json()) as { results?: any[][] };
  return body.results ?? [];
}

const pageviews = (days: number) => `event = '$pageview' and timestamp >= now() - interval ${days} day`;

async function readTraffic(projectId: string, apiKey: string, timeoutMs: number, now: number): Promise<SiteTraffic> {
  const q = (query: string) => hogql(projectId, apiKey, query, timeoutMs);
  try {
    const [totals, daily, pages, referrers] = await Promise.all([
      q(`select
           uniqIf(distinct_id, timestamp >= now() - interval 7 day),
           uniqIf(distinct_id, timestamp < now() - interval 7 day),
           countIf(timestamp >= now() - interval 7 day),
           countIf(timestamp < now() - interval 7 day)
         from events where ${pageviews(14)}`),
      q(`select toDate(toTimeZone(timestamp, 'America/Vancouver')) as day, uniq(distinct_id), count()
         from events where ${pageviews(DAYS)}
         group by day order by day`),
      q(`select properties.$pathname as path, count() as views
         from events where ${pageviews(7)} and path is not null
         group by path order by views desc limit 8`),
      q(`select properties.$referring_domain as domain, uniq(distinct_id) as visitors
         from events where ${pageviews(7)} and domain is not null and domain != '$direct' and domain not like '%openlangford.ca'
         group by domain order by visitors desc limit 6`),
    ]);
    const [visitors7, visitorsPrev7, views7, viewsPrev7] = (totals[0] ?? []).map((v) => Number(v) || 0);
    return {
      available: true,
      asOf: new Date(now).toISOString(),
      visitors: daily.map(([day, visitors]) => ({ day: String(day), value: Number(visitors) || 0 })),
      views: daily.map(([day, , views]) => ({ day: String(day), value: Number(views) || 0 })),
      visitors7: visitors7 ?? 0,
      visitorsPrev7: visitorsPrev7 ?? 0,
      views7: views7 ?? 0,
      viewsPrev7: viewsPrev7 ?? 0,
      topPages: pages.map(([path, views]) => ({ label: String(path), value: Number(views) || 0 })),
      referrers: referrers.map(([domain, visitors]) => ({ label: String(domain), value: Number(visitors) || 0 })),
    };
  } catch (error) {
    console.error("Site traffic unavailable:", error instanceof Error ? error.message : "unknown error");
    return { available: false, reason: "error", status: error instanceof PostHogError ? error.status : null };
  }
}

/**
 * Traffic for the admin overview. Stored in the PUBLIC_CACHE KV binding (shared by every Worker) and in memory.
 * Fresh for 30 minutes; after that the stored read is returned at once and PostHog is asked again in the
 * background (`waitUntil`), with a longer timeout since nobody is waiting on it. A failed read never replaces a
 * stored good one.
 */
export async function getSiteTraffic(env: Record<string, unknown>, waitUntil?: (p: Promise<unknown>) => void, now = Date.now()): Promise<SiteTraffic> {
  const apiKey = String(env.POSTHOG_PERSONAL_API_KEY ?? process.env.POSTHOG_PERSONAL_API_KEY ?? "");
  const projectId = String(env.POSTHOG_PROJECT_ID ?? process.env.POSTHOG_PROJECT_ID ?? "");
  if (!apiKey || !projectId) return { available: false, reason: "not_configured" };

  const kv = env.PUBLIC_CACHE as Kv | undefined;
  const key = `admin:site-traffic:v1:${projectId}:${apiKey.slice(-6)}`;
  let stored = memory?.key === key ? memory.stored : null;
  if (!stored || now - stored.at > FRESH_MS) {
    const fromKv = kv ? ((await kv.get(key, "json").catch(() => null)) as Stored | null) : null;
    if (fromKv?.value?.available && (!stored || fromKv.at > stored.at)) stored = fromKv;
  }
  if (stored && memory?.stored !== stored) memory = { key, stored };

  const refresh = (timeoutMs: number) => {
    refreshing ??= readTraffic(projectId, apiKey, timeoutMs, Date.now()).then(async (value) => {
      if (value.available) {
        memory = { key, stored: { at: Date.now(), value } };
        await kv?.put(key, JSON.stringify(memory.stored), { expirationTtl: 2 * 86400 }).catch(() => {});
      }
      return value;
    }).finally(() => { refreshing = null; });
    return refreshing;
  };

  if (stored && now - stored.at <= FRESH_MS) return stored.value;
  if (stored && now - stored.at <= STALE_MS) {
    const pending = refresh(25_000);
    if (waitUntil) waitUntil(pending);
    return stored.value;
  }
  return refresh(12_000);
}
