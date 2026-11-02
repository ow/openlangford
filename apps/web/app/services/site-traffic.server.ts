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
const CACHE_MS = 5 * 60_000;
const DAYS = 30;

export type DailyPoint = { day: string; value: number };

export type SiteTraffic =
  | { available: false; reason: "not_configured" }
  /** status is PostHog's HTTP status when it refused the request, null for timeouts and network errors. */
  | { available: false; reason: "error"; status: number | null }
  | {
      available: true;
      visitors: DailyPoint[];
      views: DailyPoint[];
      visitors7: number;
      visitorsPrev7: number;
      views7: number;
      viewsPrev7: number;
      topPages: { label: string; value: number }[];
      referrers: { label: string; value: number }[];
    };

let cached: { key: string; at: number; value: Promise<SiteTraffic> } | null = null;

class PostHogError extends Error {
  constructor(readonly status: number) {
    super(`PostHog query failed (${status})`);
  }
}

async function hogql(projectId: string, apiKey: string, query: string): Promise<any[][]> {
  const response = await fetch(`${POSTHOG_APP_HOST}/api/projects/${encodeURIComponent(projectId)}/query/`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: { kind: "HogQLQuery", query } }),
    signal: AbortSignal.timeout(6000),
  });
  if (!response.ok) throw new PostHogError(response.status);
  const body = (await response.json()) as { results?: any[][] };
  return body.results ?? [];
}

const pageviews = (days: number) => `event = '$pageview' and timestamp >= now() - interval ${days} day`;

async function readTraffic(projectId: string, apiKey: string): Promise<SiteTraffic> {
  const q = (query: string) => hogql(projectId, apiKey, query);
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

export function getSiteTraffic(env: Record<string, unknown>, now = Date.now()): Promise<SiteTraffic> {
  const apiKey = String(env.POSTHOG_PERSONAL_API_KEY ?? process.env.POSTHOG_PERSONAL_API_KEY ?? "");
  const projectId = String(env.POSTHOG_PROJECT_ID ?? process.env.POSTHOG_PROJECT_ID ?? "");
  if (!apiKey || !projectId) return Promise.resolve({ available: false, reason: "not_configured" });

  const key = `${projectId}:${apiKey.slice(-6)}`;
  if (!cached || cached.key !== key || now - cached.at > CACHE_MS) {
    const value = readTraffic(projectId, apiKey);
    cached = { key, at: now, value };
    // Don't hold on to a failed read for five minutes.
    value.then((t) => { if (!t.available && cached?.value === value) cached = null; });
  }
  return cached.value;
}
