/**
 * Visits and page views for the admin overview, read from PostHog's query API.
 *
 * Needs two runtime secrets: POSTHOG_PERSONAL_API_KEY (a personal key with query:read on the
 * project) and POSTHOG_PROJECT_ID. Without them the overview just says traffic isn't connected.
 *
 * The site's analytics are anonymous (lib/analytics-privacy.ts): each browser tab gets a fresh id
 * and no person profile, so a "visit" here is a tab, not a person.
 */

const POSTHOG_APP_HOST = "https://us.posthog.com";
const CACHE_MS = 5 * 60_000;

export type SiteTraffic =
  | { available: false; reason: "not_configured" | "error" }
  | {
      available: true;
      visits7: number;
      visitsPrev7: number;
      views7: number;
      daily: { day: string; visits: number }[];
      topPages: { path: string; views: number }[];
    };

let cached: { key: string; at: number; value: Promise<SiteTraffic> } | null = null;

async function hogql(host: string, projectId: string, apiKey: string, query: string): Promise<any[][]> {
  const response = await fetch(`${host}/api/projects/${encodeURIComponent(projectId)}/query/`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: { kind: "HogQLQuery", query } }),
    signal: AbortSignal.timeout(6000),
  });
  if (!response.ok) throw new Error(`PostHog query failed (${response.status})`);
  const body = (await response.json()) as { results?: any[][] };
  return body.results ?? [];
}

async function readTraffic(projectId: string, apiKey: string): Promise<SiteTraffic> {
  const q = (query: string) => hogql(POSTHOG_APP_HOST, projectId, apiKey, query);
  try {
    const [totals, daily, pages] = await Promise.all([
      q(`select
           uniqIf(distinct_id, timestamp >= now() - interval 7 day),
           uniqIf(distinct_id, timestamp < now() - interval 7 day),
           countIf(timestamp >= now() - interval 7 day)
         from events
         where event = '$pageview' and timestamp >= now() - interval 14 day`),
      q(`select toDate(toTimeZone(timestamp, 'America/Vancouver')) as day, uniq(distinct_id)
         from events
         where event = '$pageview' and timestamp >= now() - interval 14 day
         group by day order by day`),
      q(`select properties.$pathname as path, count() as views
         from events
         where event = '$pageview' and timestamp >= now() - interval 7 day and path is not null
         group by path order by views desc limit 8`),
    ]);
    const [visits7, visitsPrev7, views7] = (totals[0] ?? [0, 0, 0]).map((v) => Number(v) || 0);
    return {
      available: true,
      visits7,
      visitsPrev7,
      views7,
      daily: daily.map(([day, visits]) => ({ day: String(day), visits: Number(visits) || 0 })),
      topPages: pages.map(([path, views]) => ({ path: String(path), views: Number(views) || 0 })),
    };
  } catch (error) {
    console.error("Site traffic unavailable:", error instanceof Error ? error.message : "unknown error");
    return { available: false, reason: "error" };
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
