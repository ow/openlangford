/// <reference types="@cloudflare/workers-types" />
import { AsyncLocalStorage } from "node:async_hooks";
import { anonymousPublicRequest, publicReadRequest } from "../lib/public-cache-admission.server";

/**
 * Bump when the shape of any cached value changes. Data entries are keyed by this and the
 * content stamp only (not the deploy), so a deploy keeps every warm value.
 */
export const PUBLIC_DATA_SCHEMA = "d1";
/** Stale entries (older content stamp or past their TTL) are served at most this long after they were stored. */
export const MAX_STALE_SECONDS = 86400;

type CacheState = "HIT" | "MISS" | "BYPASS" | "STALE";
type Scope = {
  /** public_content_version stamp; no stamp (local dev, a failed read, non-GET) disables caching. */
  stamp?: string;
  /** Manual content bump (public-content-version.json); part of every data key. */
  namespace?: string;
  request: Request;
  posthogKey?: string;
  waitUntil: (promise: Promise<unknown>) => void;
  /** Optional global second tier (wrangler binding PUBLIC_CACHE). Absent: Cache API only. */
  kv?: KVNamespace;
  states: Set<CacheState>;
};
type Entry<T> = { stamp: string; storedAt: number; value: T };

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

/** An entry written under the current stamp, or a newer one (another isolate read the stamp first). */
export function stampIsCurrent(entryStamp: string | null | undefined, current: string): boolean {
  if (!entryStamp) return false;
  if (entryStamp === current) return true;
  const a = Number(entryStamp), b = Number(current);
  return Number.isFinite(a) && Number.isFinite(b) && a >= b;
}

async function kvName(prefix: string, key: string) {
  const name = `data:${prefix}:${key}`;
  if (name.length <= 480) return name;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
  return `data:${prefix}:#${[...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

function validEntry<T>(entry: unknown): entry is Entry<T> {
  return !!entry && typeof entry === "object" && typeof (entry as Entry<T>).stamp === "string" && typeof (entry as Entry<T>).storedAt === "number" && "value" in (entry as object);
}

/**
 * Only explicit, public DTO computations belong here. Keys must include municipality and all data filters.
 * Signed-in visitors bypass by default; `shareWithSignedIn` lets them use the same value too, for
 * values computed with no session (an explicit refresh still recomputes).
 *
 * Stale-while-revalidate: a value is fresh while its stamp is current and it is younger than
 * `ttlSeconds`. Otherwise an entry up to MAX_STALE_SECONDS old is served at once and recomputed in
 * the background; with no entry at all the value is computed inline. Reads go Cache API (this
 * datacenter) → KV (global, when bound) → compute; writes go to both.
 */
export async function publicData<T>(key: string, compute: () => Promise<T>, cacheable: (value: T) => boolean = () => true, ttlSeconds = TTL_SECONDS,
  { shareWithSignedIn = false }: { shareWithSignedIn?: boolean } = {}): Promise<T> {
  const scope = storage.getStore();
  const admitted = scope && (shareWithSignedIn ? publicReadRequest(scope.request) : anonymousPublicRequest(scope.request, scope.posthogKey));
  if (!scope?.stamp || !admitted || typeof caches === "undefined") {
    scope?.states.add("BYPASS");
    return compute();
  }
  const stamp = scope.stamp;
  const kv = scope.kv;
  const cache = (caches as CacheStorage & { default: Cache }).default;
  const prefix = scope.namespace ? `${PUBLIC_DATA_SCHEMA}:${scope.namespace}` : PUBLIC_DATA_SCHEMA;
  const request = new Request(`https://openlangford.ca/__public-data-cache/${encodeURIComponent(prefix)}/${encodeURIComponent(key)}`);
  const staleLimit = Math.max(ttlSeconds, MAX_STALE_SECONDS);
  const now = Date.now();
  const fresh = (entry: Entry<T>) => stampIsCurrent(entry.stamp, stamp) && now - entry.storedAt <= ttlSeconds * 1000;
  const usable = (entry: Entry<T>) => now - entry.storedAt <= staleLimit * 1000;

  const putCache = (entry: Entry<T>) => cache.put(request, Response.json(entry, {
    // X-Fresh-For is informational (freshness is checked from the entry itself).
    headers: { "Cache-Control": `public, max-age=${Math.max(1, Math.ceil(staleLimit - (Date.now() - entry.storedAt) / 1000))}`, "X-Fresh-For": String(ttlSeconds) },
  })).catch(() => {});
  const readKv = async (): Promise<Entry<T> | null> => {
    if (!kv) return null;
    try {
      const entry = await kv.get(await kvName(prefix, key), "json");
      return validEntry<T>(entry) ? entry : null;
    } catch { return null; }
  };
  const writeKv = async (entry: Entry<T>) => {
    if (!kv) return;
    try { await kv.put(await kvName(prefix, key), JSON.stringify(entry), { expirationTtl: Math.max(60, staleLimit) }); } catch { /* best effort */ }
  };

  // Compute (or, in the background, first try KV) and store; one fill per key and stamp per isolate.
  const refresh = (checkKv: boolean): Promise<T> => {
    const flightKey = `${request.url}@${stamp}`;
    let pending = inFlight.get(flightKey) as Promise<T> | undefined;
    if (!pending) {
      pending = (async () => {
        if (checkKv) {
          const global = await readKv();
          if (global && fresh(global)) { scope.waitUntil(putCache(global)); return global.value; }
        }
        const value = await compute();
        if (cacheable(value)) {
          const entry: Entry<T> = { stamp, storedAt: Date.now(), value };
          scope.waitUntil(putCache(entry));
          scope.waitUntil(writeKv(entry));
        }
        return value;
      })().finally(() => inFlight.delete(flightKey));
      inFlight.set(flightKey, pending);
    }
    return pending;
  };

  let entry: Entry<T> | null = null;
  try {
    const hit = await cache.match(request);
    if (hit) {
      const parsed = await hit.json();
      if (validEntry<T>(parsed)) entry = parsed;
    }
  } catch { /* A cache outage must not prevent an origin read. */ }
  if (entry && fresh(entry)) {
    scope.states.add("HIT");
    return entry.value;
  }
  // Nothing in this datacenter: the global tier may have it (fresh, or stale to serve now).
  let checkedKv = false;
  if (!entry && kv) {
    checkedKv = true;
    const global = await readKv();
    if (global && fresh(global)) {
      scope.states.add("HIT");
      scope.waitUntil(putCache(global));
      return global.value;
    }
    entry = global;
  }
  if (entry && usable(entry)) {
    scope.states.add("STALE");
    scope.waitUntil(refresh(!checkedKv).catch(() => {}));
    return entry.value;
  }
  scope.states.add("MISS");
  return refresh(!checkedKv);
}
