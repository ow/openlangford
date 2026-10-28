import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { loader } from "../../app/routes/api.meeting-text";
import { publicMeetingCache } from "../../workers/public-meeting-cache";
const { origin } = vi.hoisted(() => ({ origin: vi.fn() }));
vi.mock("../../app/lib/supabase.server", () => ({ getSupabaseAdminClient: () => createClient("https://origin.supabase.co", "public-test-key", { global: { fetch: origin }, auth: { persistSession: false } }) }));
let entries: Map<string, { response: Response; expires: number }>;
let jobs: Promise<unknown>[];
const config = { version: "deploy-a", posthogKey: "phc_test" };
const serve = (query: string, headers?: HeadersInit, version = config.version) => publicMeetingCache(new Request(`https://openlangford.ca/api/meeting-text?${query}`, { headers }), { ...config, version }, { waitUntil: p => jobs.push(p) }, request => loader({ request } as any));
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-21T12:00:00Z")); entries = new Map(); jobs = []; origin.mockReset();
  origin.mockImplementation(async (request: Request | string) => {
    const url = new URL(typeof request === "string" ? request : request.url); const meeting = url.searchParams.get("meeting_id");
    return Response.json(url.pathname.endsWith("transcript_segments") ? [{ id: 1, text_content: `${meeting}: ${"full transcript words ".repeat(1000)}` }] : [{ id: 2, section_text: "Public report" }]);
  });
  vi.stubGlobal("caches", { default: {
    match: async (key: Request) => { const row = entries.get(key.url); return row && row.expires > Date.now() ? row.response.clone() : undefined; },
    put: async (key: Request, response: Response) => { const ttl = Number(/max-age=(\d+)/.exec(response.headers.get("cache-control") || "")?.[1]); entries.set(key.url, { response: new Response(await response.arrayBuffer(), response), expires: Date.now() + ttl * 1000 }); },
  } });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
it("warm public transcript reads avoid another origin payload and expire corrected text in six hours (data changes end it sooner via the content stamp)", async () => {
  const query = "kind=transcript&meeting=4";
  const first = await serve(query); const body = await first.text(); await Promise.all(jobs);
  const hit = await serve(query, { Cookie: "ph_phc_test_posthog=another-visitor" });
  expect(first.headers.get("X-Public-Meeting-Cache")).toBe("MISS"); expect(hit.headers.get("X-Public-Meeting-Cache")).toBe("HIT");
  expect(hit.headers.get("Cache-Control")).toBe("private, no-store"); expect(await hit.text()).toBe(body); expect(body.length).toBeGreaterThan(20_000); expect(origin).toHaveBeenCalledTimes(1);
  origin.mockImplementation(async () => Response.json([{ id: 1, text_content: "Corrected transcript" }]));
  vi.advanceTimersByTime(6 * 3600_000 + 1);
  expect(await (await serve(query)).json()).toEqual({ texts: { 1: "Corrected transcript" } }); expect(origin).toHaveBeenCalledTimes(2);
});
it("keeps meetings, section selectors, and deployments separate", async () => {
  const queries = ["kind=transcript&meeting=4", "kind=transcript&meeting=5", "kind=sections&ids=2", "kind=sections&ids=3"];
  const bodies = [];
  for (const query of queries) { bodies.push(await (await serve(query)).text()); await Promise.all(jobs); }
  expect(bodies[0]).not.toBe(bodies[1]);
  for (let i = 0; i < queries.length; i++) expect(await (await serve(queries[i])).text()).toBe(bodies[i]);
  expect(origin).toHaveBeenCalledTimes(4);
  await serve(queries[0], undefined, "deploy-b"); expect(origin).toHaveBeenCalledTimes(5);
});
it.each(["sb-test-auth-token=session", "ph_phc_test_posthog=analytics; sb-test-auth-token.0=chunk", "unknown=personal", "consent=yes", "ph_other_posthog=id"])("bypasses shared text reads with %s", async cookie => {
  const query = "kind=transcript&meeting=4"; await serve(query); await Promise.all(jobs);
  const response = await serve(query, { Cookie: cookie }); expect(response.headers.has("X-Public-Meeting-Cache")).toBe(false); expect(origin).toHaveBeenCalledTimes(2);
});
it("bypasses authorization and explicit refresh without replacing a warm entry", async () => {
  const query = "kind=transcript&meeting=4"; await serve(query); await Promise.all(jobs);
  for (const headers of [{ Authorization: "Bearer synthetic" }, { "Cache-Control": "no-cache" }] as HeadersInit[]) expect((await serve(query, headers)).headers.has("X-Public-Meeting-Cache")).toBe(false);
  expect(origin).toHaveBeenCalledTimes(3);
});
it.each(["kind=transcript&meeting=-1", "kind=transcript&meeting=4&meeting=5", "kind=sections&ids=1,1", "kind=sections&ids=1&private=true", `kind=sections&ids=${Array.from({ length: 201 }, (_, i) => i + 1).join(",")}`])("rejects an unsafe selector without origin access: %s", async query => {
  expect((await serve(query)).status).toBe(400); expect(entries.size).toBe(0); expect(origin).not.toHaveBeenCalled();
});
it("does not cache origin errors, so the next request can recover", async () => {
  origin.mockResolvedValueOnce(Response.json({ message: "Temporary failure" }, { status: 503 }));
  expect((await serve("kind=transcript&meeting=4")).status).toBe(500); await Promise.all(jobs); expect(entries.size).toBe(0);
  expect((await serve("kind=transcript&meeting=4")).status).toBe(200); expect(origin).toHaveBeenCalledTimes(2);
});

it.each(["transcript", "sections"])("reuses verified historical %s text for 24h and refreshes corrected content with a new deployment", async kind => {
  const query = kind === "transcript" ? "kind=transcript&meeting=4" : "kind=sections&ids=2";
  const row = (text: string) => kind === "transcript" ? { id: 1, text_content: text, meetings: { meeting_date: "2016-01-01" } }
    : { id: 2, section_text: text, documents: { meetings: { meeting_date: "2016-01-01" } } };
  origin.mockImplementation(async () => Response.json([row("Original")]));
  const first = await serve(query); expect(first.headers.get("X-Public-Content-Policy")).toBe("historical"); await Promise.all(jobs);
  origin.mockImplementation(async () => Response.json([row("Corrected")]));
  vi.advanceTimersByTime(300_001);
  expect(Object.values((await (await serve(query)).json() as any).texts)).toEqual(["Original"]); expect(origin).toHaveBeenCalledTimes(1);
  expect(Object.values((await (await serve(query, undefined, "deploy-b:correction-2")).json() as any).texts)).toEqual(["Corrected"]); await Promise.all(jobs);
  vi.advanceTimersByTime(86400_000);
  expect(Object.values((await (await serve(query)).json() as any).texts)).toEqual(["Corrected"]); expect(origin).toHaveBeenCalledTimes(3);
});
it.each(["2026-10-20", null])("keeps a mixed historical/recent-or-unknown-date batch short-lived: %s", async date => {
  origin.mockImplementation(async () => Response.json([{ id: 2, section_text: "Old", documents: { meetings: { meeting_date: "2016-01-01" } } },
    { id: 3, section_text: "Changing", documents: { meetings: { meeting_date: date } } }]));
  const query = "kind=sections&ids=2,3";
  expect((await serve(query)).headers.get("X-Public-Content-Policy")).toBe("recent"); await Promise.all(jobs);
  vi.advanceTimersByTime(6 * 3600_000 + 1); await serve(query); expect(origin).toHaveBeenCalledTimes(2);
});
