import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { withPublicDataCache } from "../../app/services/public-data-cache.server";
import { sitemapEntries, type SitemapSection } from "../../app/services/sitemap.server";

let jobs: Promise<unknown>[];
let entries: Map<string, { response: Response; expires: number }>;
let catalog: ReturnType<typeof vi.fn>;
let corrected: boolean;
const client = () => createClient("https://example.supabase.co", "synthetic-key", {
  auth: { persistSession: false }, global: { fetch: catalog as typeof fetch },
});
async function read(section: SitemapSection = "documents", headers?: HeadersInit, version = "a") {
  const response = await withPublicDataCache({ request: new Request(`https://openlangford.ca/sitemaps/${section}.xml`, { headers }), stamp: "1", namespace: version,
    waitUntil: job => jobs.push(job) }, async () => Response.json(await sitemapEntries(client(), section)));
  await Promise.all(jobs); return response;
}
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-22T06:00:00Z")); jobs = []; entries = new Map(); corrected = false;
  catalog = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("municipalities")) return Response.json({ id: 1, slug: "langford" });
    if (url.pathname.endsWith("meetings")) return Response.json([{ id: 7, slug: "2020-01-01-regular-council", meeting_date: "2020-01-01" }]);
    if (url.pathname.endsWith("extracted_documents")) {
      const offset = Number(url.searchParams.get("offset") || 0);
      // A full first page forces real SDK pagination. One non-public meeting
      // row must never enter the public URL list or its cache.
      const rows = offset === 0 ? Array.from({ length: 1000 }, (_, id) => ({ id: id + 1, created_at: "2020-01-02", documents: { meeting_id: 7 } }))
        : [{ id: 1001, created_at: corrected ? "2026-10-22" : "2020-01-02", documents: { meeting_id: 7 } }, { id: 1002, documents: { meeting_id: 999 } }];
      return Response.json(rows);
    }
    if (url.pathname.endsWith("bylaws")) return Response.json([{ id: 1, slug: "public-bylaw", updated_at: "2020-01-01" }]);
    throw new Error(`Unexpected catalog request ${url.pathname}`);
  });
  vi.stubGlobal("caches", { default: {
    match: async (key: Request) => { const row = entries.get(key.url); return row && row.expires > Date.now() ? row.response.clone() : undefined; },
    put: async (key: Request, response: Response) => { entries.set(key.url, { response: new Response(await response.arrayBuffer(), response), expires: Date.now() + Number(/max-age=(\d+)/.exec(response.headers.get("cache-control")!)![1]) * 1000 }); },
  } });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
it("reuses the complete public catalog across crawls, separates sections, and refreshes corrections on expiry/version", async () => {
  const first = await read(); const urls = await first.json() as any[];
  expect(urls).toHaveLength(1001); expect(urls.at(-1)).toMatchObject({ path: "/meetings/2020-01-01-regular-council/documents/1001", lastmod: "2020-01-02" });
  const coldCalls = catalog.mock.calls.length; expect(coldCalls).toBeGreaterThanOrEqual(3);
  const warm = await read(); expect(catalog).toHaveBeenCalledTimes(coldCalls);
  expect(warm.headers.get("X-Public-Data-Cache")).toBe("HIT");
  expect(await (await read("bylaws")).json()).toMatchObject([{ path: "/bylaws/public-bylaw" }]);
  corrected = true; vi.advanceTimersByTime(3599_000);
  expect((await read()).headers.get("X-Public-Data-Cache")).toBe("HIT");
  vi.advanceTimersByTime(1001);
  // Expired: served once more while the corrected list is built in the background.
  const stale = await read();
  expect(stale.headers.get("X-Public-Data-Cache")).toBe("STALE"); expect((await stale.json() as any[]).at(-1).lastmod).toBe("2020-01-02");
  expect((await (await read()).json() as any[]).at(-1).lastmod).toBe("2026-10-22");
  expect((await read("documents", undefined, "correction-version")).headers.get("X-Public-Data-Cache")).toBe("MISS");
});
it("shares lists with signed-in visitors, bypasses an explicit refresh, and never stores a failed catalog read", async () => {
  await read(); const before = catalog.mock.calls.length;
  expect((await read("documents", { Cookie: "sb-project-auth-token=session" })).headers.get("X-Public-Data-Cache")).toBe("HIT");
  expect(catalog.mock.calls.length).toBe(before);
  expect((await read("documents", { Cookie: "sb-project-auth-token=session", "Cache-Control": "no-cache" })).headers.get("X-Public-Data-Cache")).toBe("BYPASS");
  expect(catalog.mock.calls.length).toBeGreaterThan(before);
  catalog.mockResolvedValueOnce(Response.json({ message: "catalog unavailable" }, { status: 500 }));
  await expect(read("documents", undefined, "failed-version")).rejects.toThrow();
  expect((await read("documents", undefined, "failed-version")).headers.get("X-Public-Data-Cache")).toBe("MISS");
});
