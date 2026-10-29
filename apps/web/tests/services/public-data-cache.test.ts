import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { publicData, withPublicDataCache } from "../../app/services/public-data-cache.server";
let entries: Map<string, { response: Response; expires: number }>;
let jobs: Promise<unknown>[];
const settle = async () => { while (jobs.length) await Promise.all(jobs.splice(0)); };
type Opts = { headers?: HeadersInit; stamp?: string; cacheable?: (value: any) => boolean; kv?: KVNamespace; ttl?: number; shared?: boolean };
const run = (key: string, compute: () => Promise<any>, { headers, stamp = "1000", cacheable, kv, ttl, shared }: Opts = {}) => withPublicDataCache({
  request: new Request("https://openlangford.ca/people.data?_routes=routes%2Fpeople", { headers }), stamp, posthogKey: "phc_test", waitUntil: job => jobs.push(job), kv,
}, async () => Response.json(await publicData(key, compute, cacheable, ttl, { shareWithSignedIn: shared })));
const state = (response: Response) => response.headers.get("X-Public-Data-Cache");

function memoryKv() {
  const store = new Map<string, string>();
  const kv = {
    get: vi.fn(async (name: string, type?: string) => { const v = store.get(name); return v === undefined ? null : type === "json" ? JSON.parse(v) : v; }),
    put: vi.fn(async (name: string, value: string) => { store.set(name, value); }),
  };
  return { kv: kv as unknown as KVNamespace, store, calls: kv };
}

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-21T12:00:00Z")); entries = new Map(); jobs = [];
  vi.stubGlobal("caches", { default: {
    match: async (key: Request) => { const row = entries.get(key.url); return row && row.expires > Date.now() ? row.response.clone() : undefined; },
    put: async (key: Request, response: Response) => { const ttl = Number(/max-age=(\d+)/.exec(response.headers.get("cache-control") || "")?.[1]); entries.set(key.url, { response: new Response(await response.arrayBuffer(), response), expires: Date.now() + ttl * 1000 }); },
  } });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it("shares public summaries outside the origin, coalesces concurrent fills, and serves stale while refreshing after expiry", async () => {
  let release!: (value: any) => void;
  const compute = vi.fn(() => new Promise(resolve => { release = resolve; }));
  const first = run("council:1:2026", compute); const second = run("council:1:2026", compute);
  await vi.waitFor(() => expect(compute).toHaveBeenCalledTimes(1)); release({ public: "A summary" });
  await Promise.all([first, second]); await settle();
  const hit = await run("council:1:2026", compute, { headers: { Cookie: "ph_phc_test_posthog=another-visitor" } });
  expect(state(hit)).toBe("HIT"); expect(await hit.json()).toEqual({ public: "A summary" });
  expect(compute).toHaveBeenCalledTimes(1);
  compute.mockResolvedValue({ public: "Corrected summary" }); vi.advanceTimersByTime(300_001);
  // Past its TTL: the old value is served at once and recomputed in the background.
  const stale = await run("council:1:2026", compute);
  expect(state(stale)).toBe("STALE"); expect(await stale.json()).toEqual({ public: "A summary" });
  await settle(); expect(compute).toHaveBeenCalledTimes(2);
  const refreshed = await run("council:1:2026", compute);
  expect(state(refreshed)).toBe("HIT"); expect(await refreshed.json()).toEqual({ public: "Corrected summary" });
});

it("keys data by content stamp, not deployment: a newer stamp serves stale then refreshes; an older isolate's stamp reads newer data as fresh", async () => {
  const compute = vi.fn(async () => ({ v: "at-1000" }));
  await run("meetings:1:2026", compute, { stamp: "1000" }); await settle();
  compute.mockResolvedValue({ v: "at-2000" });
  const stale = await run("meetings:1:2026", compute, { stamp: "2000" });
  expect(state(stale)).toBe("STALE"); expect(await stale.json()).toEqual({ v: "at-1000" });
  await settle(); expect(compute).toHaveBeenCalledTimes(2);
  expect(await (await run("meetings:1:2026", compute, { stamp: "2000" })).json()).toEqual({ v: "at-2000" });
  // An isolate still holding the previous stamp treats the newer entry as current.
  expect(state(await run("meetings:1:2026", compute, { stamp: "1000" }))).toBe("HIT");
  expect(compute).toHaveBeenCalledTimes(2);
});

it("bounds staleness: an entry older than a day is recomputed inline", async () => {
  const compute = vi.fn(async () => ({ v: "old" }));
  await run("home:1", compute); await settle();
  compute.mockResolvedValue({ v: "new" });
  vi.advanceTimersByTime(86400_000 + 1);
  const response = await run("home:1", compute, { stamp: "5000" });
  expect(state(response)).toBe("MISS"); expect(await response.json()).toEqual({ v: "new" });
});

it("isolates municipality and data filters independently of root/user response state", async () => {
  const compute = vi.fn(async () => ({ value: "first" }));
  for (const key of ["meetings:1:2026", "meetings:2:2026", "meetings:1:2025"]) { await run(key, compute); await settle(); }
  expect(compute).toHaveBeenCalledTimes(3);
  for (const key of ["meetings:1:2026", "meetings:2:2026", "meetings:1:2025"]) expect(state(await run(key, compute))).toBe("HIT");
  const render = (user: string) => withPublicDataCache({ request: new Request("https://openlangford.ca/people"), stamp: "1000", waitUntil: job => jobs.push(job) }, async () => Response.json({ public: await publicData("meetings:1:2026", compute), user }, { headers: { "Set-Cookie": `session=${user}` } }));
  const a = await render("A"), b = await render("B");
  expect((await a.json() as { user: string }).user).toBe("A"); expect((await b.json() as { user: string }).user).toBe("B"); expect(b.headers.get("Set-Cookie")).toBe("session=B");
  expect(entries.size).toBe(3); // Only public JSON values, never these session responses.
});

it.each<HeadersInit>([
  { Cookie: "sb-test-auth-token=session" }, { Cookie: "ph_phc_test_posthog=analytics; sb-test-auth-token.0=chunk" },
  { Cookie: "unknown=private" }, { Authorization: "Bearer synthetic" }, { "Cache-Control": "no-cache" },
])("bypasses warm and in-flight values not opted in for signed-in sharing, for non-anonymous requests %j", async headers => {
  const compute = vi.fn(async () => ({ public: "origin" })); await run("council:1", compute); await settle();
  const response = await run("council:1", compute, { headers });
  expect(state(response)).toBe("BYPASS"); expect(compute).toHaveBeenCalledTimes(2);
});

it("does not store errors or incomplete summaries and falls back when the cache is unavailable", async () => {
  await expect(run("home:1", async () => { throw new Error("offline"); })).rejects.toThrow("offline"); expect(entries.size).toBe(0);
  await run("home:1", async () => ({ complete: false }), { cacheable: value => value.complete }); await settle(); expect(entries.size).toBe(0);
  vi.stubGlobal("caches", { default: { match: async () => { throw new Error("unavailable"); }, put: async () => { throw new Error("unavailable"); } } });
  expect(await (await run("home:1", async () => ({ complete: true }))).json()).toEqual({ complete: true }); await settle();
});

it("never caches without a content stamp", async () => {
  const compute = vi.fn(async () => ({ v: 1 }));
  await run("x", compute, { stamp: "" }); await run("x", compute, { stamp: "" }); await settle();
  expect(compute).toHaveBeenCalledTimes(2); expect(entries.size).toBe(0);
});

it("shares opted-in aggregates with signed-in visitors, but an explicit refresh still recomputes", async () => {
  const compute = vi.fn(async () => ({ public: "index" }));
  await run("properties-index", compute, { headers: { Cookie: "sb-test-auth-token=session" }, shared: true }); await settle();
  expect(state(await run("properties-index", compute, { headers: { Cookie: "sb-test-auth-token=other" }, shared: true }))).toBe("HIT");
  expect(state(await run("properties-index", compute, { shared: true }))).toBe("HIT");
  expect(state(await run("properties-index", compute, { headers: { Cookie: "sb-test-auth-token=session", "Cache-Control": "no-cache" }, shared: true }))).toBe("BYPASS");
  expect(compute).toHaveBeenCalledTimes(2);
});

it("uses KV as a global second tier when bound: writes both, and a datacenter miss reads KV instead of computing", async () => {
  const { kv, store, calls } = memoryKv();
  const compute = vi.fn(async () => ({ v: "computed" }));
  await run("council:1", compute, { kv }); await settle();
  expect(store.size).toBe(1); expect(entries.size).toBe(1);
  entries.clear(); // another datacenter: empty Cache API
  const fromKv = await run("council:1", compute, { kv });
  expect(state(fromKv)).toBe("HIT"); expect(await fromKv.json()).toEqual({ v: "computed" });
  expect(compute).toHaveBeenCalledTimes(1);
  await settle(); expect(entries.size).toBe(1); // backfilled into this datacenter
  // A stale KV value is served at once while recomputing; both tiers get the new value.
  entries.clear(); compute.mockResolvedValue({ v: "recomputed" });
  const stale = await run("council:1", compute, { kv, stamp: "2000" });
  expect(state(stale)).toBe("STALE"); expect(await stale.json()).toEqual({ v: "computed" });
  await settle(); expect(compute).toHaveBeenCalledTimes(2);
  expect(JSON.parse([...store.values()][0]).value).toEqual({ v: "recomputed" });
  expect(calls.put).toHaveBeenCalledTimes(2);
  // Keys too long for KV are hashed.
  await run("k".repeat(600), compute, { kv }); await settle();
  expect([...store.keys()].every((name) => name.length <= 512)).toBe(true);
});

it("works identically without KV, and a failing KV never breaks a read", async () => {
  const compute = vi.fn(async () => ({ v: 1 }));
  expect(await (await run("a", compute)).json()).toEqual({ v: 1 }); await settle();
  expect(state(await run("a", compute))).toBe("HIT");
  const broken = { get: async () => { throw new Error("kv down"); }, put: async () => { throw new Error("kv down"); } } as unknown as KVNamespace;
  entries.clear();
  const response = await run("a", compute, { kv: broken });
  expect(state(response)).toBe("MISS"); expect(await response.json()).toEqual({ v: 1 }); await settle();
  expect(state(await run("a", compute, { kv: broken }))).toBe("HIT");
});
