/// <reference types="@cloudflare/workers-types" />
import { AsyncLocalStorage } from "node:async_hooks";
import { anonymousPublicRequest, publicReadRequest } from "../lib/public-cache-admission.server";

type Scope = {
  version?: string;
  request: Request;
  posthogKey?: string;
  waitUntil: (promise: Promise<unknown>) => void;
  states: Set<"HIT" | "MISS" | "BYPASS">;
};
const storage = new AsyncLocalStorage<Scope>();
const inFlight = new Map<string, Promise<unknown>>();
const TTL_SECONDS = 300;

/** Request-scoped metadata only; user/session/root loader data never enter this cache. */
export async function withPublicDataCache(scope: Omit<Scope, "states">, render: () => Promise<Response>): Promise<Response> {
  const context: Scope = { ...scope, states: new Set() };
  return storage.run(context, async () => {
    const response = await render();
    if (!context.states.size) return response;
    const delivered = new Response(response.body, response);
    delivered.headers.set("X-Public-Data-Cache", [...context.states].sort().join(","));
    delivered.headers.set("Cache-Control", "private, no-store");
    return delivered;
  });
}

/**
 * Only explicit, public DTO computations belong here. Keys must include municipality and all data filters.
 * Signed-in visitors bypass by default; `shareWithSignedIn` lets them use the same value too, for
 * expensive aggregates computed with no session (an explicit refresh still recomputes).
 */
export async function publicData<T>(key: string, compute: () => Promise<T>, cacheable: (value: T) => boolean = () => true, ttlSeconds = TTL_SECONDS,
  { shareWithSignedIn = false }: { shareWithSignedIn?: boolean } = {}): Promise<T> {
  const scope = storage.getStore();
  const admitted = scope && (shareWithSignedIn ? publicReadRequest(scope.request) : anonymousPublicRequest(scope.request, scope.posthogKey));
  if (!scope?.version || !admitted || typeof caches === "undefined") {
    scope?.states.add("BYPASS");
    return compute();
  }
  const cache = (caches as CacheStorage & { default: Cache }).default;
  const request = new Request(`https://openlangford.ca/__public-data-cache/${scope.version}/${encodeURIComponent(key)}`);
  try {
    const hit = await cache.match(request);
    if (hit) {
      const value = await hit.json() as T;
      scope.states.add("HIT");
      return value;
    }
  } catch { /* A cache outage must not prevent an origin read. */ }
  scope.states.add("MISS");
  let pending = inFlight.get(request.url) as Promise<T> | undefined;
  if (!pending) {
    pending = compute().then((value) => {
      if (cacheable(value)) {
        const response = Response.json(value, { headers: { "Cache-Control": `public, max-age=${ttlSeconds}` } });
        scope.waitUntil(cache.put(request, response).catch(() => {}));
      }
      return value;
    }).finally(() => inFlight.delete(request.url));
    inFlight.set(request.url, pending);
  }
  return pending;
}
