/// <reference types="@cloudflare/workers-types" />

import { anonymousPublicRequest, signedInPublicRequest } from "../app/lib/public-cache-admission.server";
import { parseMeetingTextRequest } from "../app/lib/meeting-text-request";

import { historicalPublicDate, HISTORICAL_PUBLIC_TTL, RECENT_PUBLIC_TTL } from "../app/lib/public-content-cache";
import { MAX_STALE_SECONDS, stampIsCurrent } from "../app/services/public-data-cache.server";

// Entries are keyed by deployment and URL, and carry the database's last-change stamp
// (workers/content-version.ts). An entry is fresh while its stamp is current and it is
// younger than its TTL; otherwise, for up to a day, it is served at once while a fresh copy
// renders in the background (stale-while-revalidate). The TTL only bounds time-relative text
// ("in 3 days") and site flags in the root loader. Never across deployments: old HTML would
// point at old script bundles.
const PAGE_TTL = 6 * 3600;

type PublicMeetingCacheConfig = { deploy?: string; stamp?: string; posthogKey?: string };

// Detail pages whose loaders read no session. Short TTL.
const PUBLIC_PAGES: [RegExp, string][] = [
  [/^\/matters\/[a-z0-9-]+$/, "routes/matter-detail"],
  [/^\/bylaws\/[a-z0-9-]+$/, "routes/bylaw-detail"],
  [/^\/properties\/[a-z0-9-]+$/, "routes/property-detail"],
  [/^\/people\/[a-z0-9-]+$/, "routes/person-profile"],
  [/^\/people\/[a-z0-9-]+\/votes$/, "routes/person-votes"],
  [/^\/people\/[a-z0-9-]+\/proposals$/, "routes/person-proposals"],
  [/^\/participants\/[a-z0-9-]+$/, "routes/participant-profile"],
  [/^\/elections\/[a-z0-9-]+$/, "routes/election-detail"],
];

// Index pages (no query string), also session-free. They show "upcoming"/"recent" lists, so a
// five-minute TTL. The home loader's only cookie (the onboarding flash) fails admission.
const INDEX_PAGES: Record<string, string> = {
  "/": "routes/home",
  "/meetings": "routes/meetings",
  "/matters": "routes/matters",
  "/people": "routes/people",
  "/participants": "routes/participants",
  "/bylaws": "routes/bylaws",
  "/properties": "routes/properties",
};

function publicPage(pathname: string): { route: string; ttl: number } | null {
  // React Router fetches the index route's data from /_root.data.
  const path = pathname === "/_root.data" ? "/" : pathname.replace(/\.data$/, "");
  if (INDEX_PAGES[path]) return { route: INDEX_PAGES[path], ttl: RECENT_PUBLIC_TTL };
  const route = PUBLIC_PAGES.find(([pattern]) => pattern.test(path))?.[1];
  return route ? { route, ttl: PAGE_TTL } : null;
}

type CacheKey = { key: Request; ttl: number };

function cacheKey(request: Request, { deploy, posthogKey }: PublicMeetingCacheConfig): CacheKey | null {
  const url = new URL(request.url);
  const anonymous = anonymousPublicRequest(request, posthogKey);
  // Signed-in visitors share only route-only navigation data (checked below).
  if (!anonymous && !signedInPublicRequest(request, posthogKey)) return null;

  if (url.pathname === "/api/meeting-text") {
    if (!anonymous || !parseMeetingTextRequest(url) || !["", "*/*", "application/json"].includes(request.headers.get("accept") || "")) return null;
    url.pathname = `/__public-meeting-cache/${deploy}/api/meeting-text`;
    return { key: new Request(url, { method: "GET" }), ttl: PAGE_TTL };
  }

  const match = /^\/meetings\/(\d{4}-\d{2}-\d{2})-[a-z0-9-]+(\/documents(?:\/[1-9][0-9]*)?)?(\.data)?$/.exec(url.pathname);
  const page = match ? null : publicPage(url.pathname);
  if (!match && !page) return null;
  if (match) {
    const date = Date.parse(`${match[1]}T00:00:00Z`);
    if (!Number.isFinite(date) || new Date(date).toISOString().slice(0, 10) !== match[1] || date > Date.now() - 2 * 86400_000) return null;
  }

  const isData = match ? !!match[3] : url.pathname.endsWith(".data");
  const accept = request.headers.get("accept") || "";
  // A page asked for with no preference (curl, many crawlers and link previewers send */* or
  // nothing) gets the same HTML as a browser, so it shares the HTML entry.
  const html = (accept.includes("text/html") || accept === "" || accept === "*/*") && !/markdown|json/i.test(accept);
  if (isData ? !["", "*/*", "text/x-script"].includes(accept) : !html) return null;
  // React Router uses _routes to request only the loaders it needs. Never
  // conflate that with a full navigation payload, or with another route.
  const allowedRoute = page?.route ?? (match![2]?.startsWith("/documents/") ? "routes/document-viewer" : match![2] ? "routes/meeting-documents" : "routes/meeting-detail");
  let routeOnly = false;
  for (const [name, value] of url.searchParams) {
    if (!isData || name !== "_routes" || url.searchParams.getAll(name).length !== 1) return null;
    const routes = value.split(",");
    if (!routes.length || new Set(routes).size !== routes.length || routes.some((route) => route !== "root" && route !== allowedRoute)) return null;
    routeOnly = !routes.includes("root");
  }
  // HTML and root-inclusive payloads carry the visitor's session state: anonymous only.
  if (!anonymous && !routeOnly) return null;
  const date = match?.[1];
  const ttl = page ? page.ttl : routeOnly && historicalPublicDate(date) ? HISTORICAL_PUBLIC_TTL : PAGE_TTL;
  // Synthetic keys are not routes. Original path (including .data), complete
  // safe query, and Worker version keep representations/deployments separate.
  url.pathname = `/__public-meeting-cache/${deploy}${url.pathname}`;
  return { key: new Request(url, { method: "GET" }), ttl };
}

function canStore(response: Response, representation: "data" | "text" | "html") {
  const headers = response.headers;
  const type = headers.get("content-type") || "";
  return response.status === 200 &&
    (representation === "data" ? type.startsWith("text/x-script") : representation === "text" ? type.startsWith("application/json") : type.startsWith("text/html")) &&
    !headers.has("set-cookie") && !headers.has("location") &&
    !/private|no-store|no-cache|(?:s-maxage|max-age)\s*=\s*0(?:,|$)/i.test(headers.get("cache-control") || "") &&
    (headers.get("vary") || "").split(",").every((v) => ["", "accept", "accept-encoding"].includes(v.trim().toLowerCase()));
}

const INTERNAL_HEADERS = ["X-Content-Stamp", "X-Stored-At", "X-Fresh-For"];

function delivery(response: Response, state: "HIT" | "MISS" | "STALE") {
  const delivered = new Response(response.body, response);
  // Cache only inside this guarded Worker path. Browsers/downstream proxies
  // must re-enter the session guard on every request, including after login.
  delivered.headers.set("Cache-Control", "private, no-store");
  delivered.headers.set("X-Public-Meeting-Cache", state);
  for (const name of INTERNAL_HEADERS) delivered.headers.delete(name);
  return delivered;
}

const rendering = new Map<string, Promise<unknown>>();

export async function publicMeetingCache(
  request: Request,
  config: PublicMeetingCacheConfig,
  ctx: Pick<ExecutionContext, "waitUntil">,
  render: (request: Request) => Promise<Response>,
): Promise<Response> {
  const cached = config.deploy && config.stamp ? cacheKey(request, config) : null;
  if (!cached) {
    const response = await render(request);
    if (new URL(request.url).pathname === "/api/meeting-text") response.headers.set("Cache-Control", "private, no-store");
    return response;
  }
  const { key, ttl } = cached;
  const stamp = config.stamp!;
  const cache = (caches as CacheStorage & { default: Cache }).default;
  const path = new URL(request.url).pathname;
  // The browser keeps its cookies; SSR gets a cookie-free request. Thus even future loader
  // changes cannot personalize the shared response from session or analytics identifiers.
  const headers = new Headers(request.headers);
  headers.delete("cookie");
  const publicRequest = () => new Request(request, { headers });

  const fill = async (response: Response) => {
    if (!canStore(response, path === "/api/meeting-text" ? "text" : path.endsWith(".data") ? "data" : "html")) return false;
    const stored = new Response(response.clone().body, response);
    // Verified historical meeting text gets 24h; everything else the route's TTL.
    const freshFor = path === "/api/meeting-text" && response.headers.get("X-Public-Content-Policy") === "historical" ? HISTORICAL_PUBLIC_TTL : ttl;
    stored.headers.set("Cache-Control", `public, max-age=${Math.max(freshFor, MAX_STALE_SECONDS)}`);
    stored.headers.set("X-Content-Stamp", stamp);
    stored.headers.set("X-Stored-At", String(Date.now()));
    stored.headers.set("X-Fresh-For", String(freshFor));
    ctx.waitUntil(cache.put(key, stored).catch(() => {}));
    return true;
  };

  try {
    const hit = await cache.match(key);
    if (hit) {
      const age = Date.now() - Number(hit.headers.get("X-Stored-At"));
      const freshFor = Number(hit.headers.get("X-Fresh-For")) || ttl;
      if (stampIsCurrent(hit.headers.get("X-Content-Stamp"), stamp) && age <= freshFor * 1000) return delivery(hit, "HIT");
      if (age <= Math.max(freshFor, MAX_STALE_SECONDS) * 1000) {
        // Serve what we have now; one background render per URL per isolate refreshes it.
        if (!rendering.has(key.url)) {
          const job = render(publicRequest()).then(fill).catch(() => {}).finally(() => rendering.delete(key.url));
          rendering.set(key.url, job);
          ctx.waitUntil(job);
        }
        return delivery(hit, "STALE");
      }
    }
  } catch {
    // Cache availability must never make a working page unavailable.
  }
  const response = await render(publicRequest());
  if (!(await fill(response))) return response;
  return delivery(response, "MISS");
}
