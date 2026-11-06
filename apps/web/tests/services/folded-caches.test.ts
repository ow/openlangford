import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { withPublicDataCache } from "../../app/services/public-data-cache.server";
import { getMunicipality } from "../../app/services/municipality";
import { getCouncilTerms } from "../../app/services/council-terms";
import { getVideoSourceSetting } from "../../app/services/video/index.server";

// Former per-isolate Map caches now go through publicData: they follow the content stamp and are
// served to every visitor (they hold public rows), and failures are never kept.
let entries: Map<string, Response>;
let jobs: Promise<unknown>[];
const settle = async () => { while (jobs.length) await Promise.all(jobs.splice(0)); };
const within = <T>(stamp: string, fn: () => Promise<T>, headers?: HeadersInit) => withPublicDataCache({
  request: new Request("https://openlangford.ca/x", { headers }), stamp, waitUntil: (job) => jobs.push(job),
}, async () => Response.json(await fn())).then((r) => r.json() as Promise<T>);

function client(rows: Record<string, unknown>[] | Error) {
  const query: any = { select: () => query, eq: () => query, order: () => query, single: async () => ({ data: rows instanceof Error ? null : rows[0], error: rows instanceof Error ? rows : null }), maybeSingle: async () => ({ data: rows instanceof Error ? null : rows[0], error: null }) };
  const from = vi.fn(() => query);
  return { supabase: { from } as any, from };
}

beforeEach(() => {
  entries = new Map(); jobs = [];
  vi.stubGlobal("caches", { default: {
    match: async (key: Request) => entries.get(key.url)?.clone(),
    put: async (key: Request, response: Response) => { entries.set(key.url, new Response(await response.arrayBuffer(), response)); },
  } });
});
afterEach(() => vi.unstubAllGlobals());

it("serves the municipality row to every visitor from one query per content stamp", async () => {
  const { supabase, from } = client([{ id: 1, slug: "langford" }]);
  await within("1", () => getMunicipality(supabase)); await settle();
  expect((await within("1", () => getMunicipality(supabase), { Cookie: "sb-x-auth-token=session" }))).toMatchObject({ id: 1 });
  expect(from).toHaveBeenCalledTimes(1);
  // A content change makes it stale at once: served, then refreshed in the background.
  await within("2", () => getMunicipality(supabase)); await settle();
  expect(from).toHaveBeenCalledTimes(2);
});

it("does not keep a missing municipality or a failed terms read", async () => {
  const missing = client(new Error("nope"));
  await expect(within("1", () => getMunicipality(missing.supabase, "gone"))).rejects.toThrow("Municipality not found");
  await settle(); expect(entries.size).toBe(0);
  const noTable = { from: () => ({ select: () => ({ eq: () => ({ order: async () => ({ data: null, error: { code: "42P01" } }) }) }) }) } as any;
  expect(await within("1", () => getCouncilTerms(noTable, 1))).toEqual([]);
  await settle(); expect(entries.size).toBe(0);
});

it("does not keep a failed video setting read, and keeps a good one", async () => {
  const failing = { from: () => { throw new Error("down"); } } as any;
  expect(await within("1", () => getVideoSourceSetting(failing, "langford"))).toEqual({ id: null, config: null });
  await settle(); expect(entries.size).toBe(0);
  const { supabase, from } = client([{ video_source: { type: "isilive", x: 1 } }]);
  expect(await within("1", () => getVideoSourceSetting(supabase, "langford"))).toEqual({ id: "escribe-isi", config: { type: "isilive", x: 1 } });
  await settle(); await within("1", () => getVideoSourceSetting(supabase, "langford"));
  expect(from).toHaveBeenCalledTimes(1);
});
