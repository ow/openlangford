import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { publicData, withPublicDataCache } from "../../app/services/public-data-cache.server";
let entries: Map<string, { response: Response; expires: number }>;
let jobs: Promise<unknown>[];
const run = (key: string, compute: () => Promise<any>, headers?: HeadersInit, version = "deploy-a", cacheable?: (value: any) => boolean) => withPublicDataCache({
  request: new Request("https://openlangford.ca/people.data?_routes=routes%2Fpeople", { headers }), version, posthogKey: "phc_test", waitUntil: job => jobs.push(job),
}, async () => Response.json(await publicData(key, compute, cacheable)));
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-21T12:00:00Z")); entries = new Map(); jobs = [];
  vi.stubGlobal("caches", { default: {
    match: async (key: Request) => { const row = entries.get(key.url); return row && row.expires > Date.now() ? row.response.clone() : undefined; },
    put: async (key: Request, response: Response) => { const ttl = Number(/max-age=(\d+)/.exec(response.headers.get("cache-control") || "")?.[1]); entries.set(key.url, { response: new Response(await response.arrayBuffer(), response), expires: Date.now() + ttl * 1000 }); },
  } });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
it("shares public summaries outside the origin, coalesces concurrent fills, and refreshes corrections after expiry or deploy", async () => {
  let release!: (value: any) => void;
  const compute = vi.fn(() => new Promise(resolve => { release = resolve; }));
  const first = run("council:1:2026", compute); const second = run("council:1:2026", compute);
  await vi.waitFor(() => expect(compute).toHaveBeenCalledTimes(1)); release({ public: "A summary" });
  await Promise.all([first, second]); await Promise.all(jobs);
  const hit = await run("council:1:2026", compute, { Cookie: "ph_phc_test_posthog=another-visitor" });
  expect(hit.headers.get("X-Public-Data-Cache")).toBe("HIT"); expect(await hit.json()).toEqual({ public: "A summary" });
  expect(compute).toHaveBeenCalledTimes(1);
  compute.mockResolvedValue({ public: "Corrected summary" }); vi.advanceTimersByTime(300_001);
  expect(await (await run("council:1:2026", compute)).json()).toEqual({ public: "Corrected summary" }); await Promise.all(jobs);
  await run("council:1:2026", compute, undefined, "deploy-b"); expect(compute).toHaveBeenCalledTimes(3);
});
it("isolates municipality and data filters independently of root/user response state", async () => {
  const compute = vi.fn(async () => ({ value: "first" }));
  for (const key of ["meetings:1:2026", "meetings:2:2026", "meetings:1:2025"]) { await run(key, compute); await Promise.all(jobs); }
  expect(compute).toHaveBeenCalledTimes(3);
  for (const key of ["meetings:1:2026", "meetings:2:2026", "meetings:1:2025"]) expect((await run(key, compute)).headers.get("X-Public-Data-Cache")).toBe("HIT");
  const render = (user: string) => withPublicDataCache({ request: new Request("https://openlangford.ca/people"), version: "deploy-a", waitUntil: job => jobs.push(job) }, async () => Response.json({ public: await publicData("meetings:1:2026", compute), user }, { headers: { "Set-Cookie": `session=${user}` } }));
  const a = await render("A"), b = await render("B");
  expect((await a.json() as { user: string }).user).toBe("A"); expect((await b.json() as { user: string }).user).toBe("B"); expect(b.headers.get("Set-Cookie")).toBe("session=B");
  expect(entries.size).toBe(3); // Only public JSON values, never these session responses.
});
it.each<HeadersInit>([
  { Cookie: "sb-test-auth-token=session" }, { Cookie: "ph_phc_test_posthog=analytics; sb-test-auth-token.0=chunk" },
  { Cookie: "unknown=private" }, { Authorization: "Bearer synthetic" }, { "Cache-Control": "no-cache" },
])("bypasses warm and in-flight shared values for non-anonymous requests %j", async headers => {
  const compute = vi.fn(async () => ({ public: "origin" })); await run("council:1", compute); await Promise.all(jobs);
  const response = await run("council:1", compute, headers);
  expect(response.headers.get("X-Public-Data-Cache")).toBe("BYPASS"); expect(compute).toHaveBeenCalledTimes(2);
});
it("does not store errors or incomplete summaries and falls back when the cache is unavailable", async () => {
  await expect(run("home:1", async () => { throw new Error("offline"); })).rejects.toThrow("offline"); expect(entries.size).toBe(0);
  await run("home:1", async () => ({ complete: false }), undefined, "deploy-a", value => value.complete); await Promise.all(jobs); expect(entries.size).toBe(0);
  vi.stubGlobal("caches", { default: { match: async () => { throw new Error("unavailable"); }, put: async () => { throw new Error("unavailable"); } } });
  expect(await (await run("home:1", async () => ({ complete: true }))).json()).toEqual({ complete: true }); await Promise.all(jobs);
});
it("shares opted-in aggregates with signed-in visitors, but an explicit refresh still recomputes", async () => {
  const compute = vi.fn(async () => ({ public: "index" }));
  const shared = (headers?: HeadersInit) => withPublicDataCache({
    request: new Request("https://openlangford.ca/properties", { headers }), version: "deploy-a", posthogKey: "phc_test", waitUntil: job => jobs.push(job),
  }, async () => Response.json(await publicData("properties-index", compute, () => true, 3600, { shareWithSignedIn: true })));
  await shared({ Cookie: "sb-test-auth-token=session" }); await Promise.all(jobs);
  expect((await shared({ Cookie: "sb-test-auth-token=other" })).headers.get("X-Public-Data-Cache")).toBe("HIT");
  expect((await shared()).headers.get("X-Public-Data-Cache")).toBe("HIT");
  expect((await shared({ Cookie: "sb-test-auth-token=session", "Cache-Control": "no-cache" })).headers.get("X-Public-Data-Cache")).toBe("BYPASS");
  expect(compute).toHaveBeenCalledTimes(2);
});
