import { afterEach, describe, expect, it, vi } from "vitest";

const results = { results: [[3, 2, 10, 8]] };
function fakeKv() {
  const store = new Map<string, string>();
  return { store, get: async (k: string) => (store.has(k) ? JSON.parse(store.get(k)!) : null), put: async (k: string, v: string) => { store.set(k, v); } };
}
const env = (kv: any) => ({ POSTHOG_PERSONAL_API_KEY: "phx_test123456", POSTHOG_PROJECT_ID: "1", PUBLIC_CACHE: kv });

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

describe("getSiteTraffic", () => {
  it("reads PostHog once, then serves the stored read for 30 minutes", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify(results)));
    vi.stubGlobal("fetch", fetch);
    const { getSiteTraffic } = await import("../site-traffic.server");
    const kv = fakeKv(), t0 = Date.now();
    const first = await getSiteTraffic(env(kv), undefined, t0);
    expect(first.available).toBe(true);
    const calls = fetch.mock.calls.length;
    await getSiteTraffic(env(kv), undefined, t0 + 29 * 60_000);
    expect(fetch.mock.calls.length).toBe(calls);
    expect(kv.store.size).toBe(1);
  });

  it("serves a stale read at once and refreshes it in the background", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(results))));
    const { getSiteTraffic } = await import("../site-traffic.server");
    const kv = fakeKv();
    await getSiteTraffic(env(kv), undefined, Date.now());
    const waited: Promise<unknown>[] = [];
    const later = Date.now() + 2 * 60 * 60_000;
    const value = await getSiteTraffic(env(kv), (p) => waited.push(p), later);
    expect(value.available).toBe(true);
    expect(waited).toHaveLength(1);
  });

  it("keeps the stored read when PostHog fails", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify(results)));
    vi.stubGlobal("fetch", fetch);
    const { getSiteTraffic } = await import("../site-traffic.server");
    const kv = fakeKv();
    await getSiteTraffic(env(kv), undefined, Date.now());
    fetch.mockImplementation(async () => new Response("no", { status: 500 }));
    const waited: Promise<unknown>[] = [];
    await getSiteTraffic(env(kv), (p) => waited.push(p), Date.now() + 2 * 60 * 60_000);
    await Promise.all(waited);
    const again = await getSiteTraffic(env(kv), undefined, Date.now() + 2 * 60 * 60_000);
    expect(again.available).toBe(true);
  });
});
