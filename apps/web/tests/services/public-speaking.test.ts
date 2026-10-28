import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { withPublicDataCache } from "../../app/services/public-data-cache.server";
import { getPublicSpeakingTimeStats, getPublicSpeakingTimeByMeeting, getPublicSpeakingTimeByTopic } from "../../app/services/public-speaking.server";
const state = vi.hoisted(() => ({ client: null as any }));
vi.mock("../../app/lib/supabase.server", () => ({ getSupabaseAdminClient: () => state.client }));
let entries: Map<string, { response: Response; expires: number }>;
let jobs: Promise<unknown>[];
let origin: ReturnType<typeof vi.fn>;
const ranking = [{ person_id: 1, person_name: "Public Person", image_url: null, total_seconds: 12.5, meeting_count: 2, segment_count: 3 }];
const meetings = [{ meeting_id: 2, meeting_date: "2020-01-01", seconds_spoken: 12.5, segment_count: 3 }];
const topics = [{ topic: "Housing", total_seconds: 12.5, segment_count: 3 }];
async function run(compute: () => Promise<unknown>, headers?: HeadersInit, version = "a") {
  const result = await withPublicDataCache({ request: new Request("https://openlangford.ca/people/person.data", { headers }), version, posthogKey: "phc_test", waitUntil: job => jobs.push(job) }, async () => Response.json(await compute()));
  await Promise.all(jobs); return result;
}
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-21T12:00:00Z")); entries = new Map(); jobs = [];
  origin = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input); const rows = url.endsWith("get_speaking_time_stats") ? ranking : url.endsWith("get_speaking_time_by_meeting") ? meetings : topics;
    return Response.json(rows.map(row => ({ ...row, private_future_field: "excluded" })));
  });
  state.client = createClient("https://example.supabase.co", "synthetic-test-key", { global: { fetch: origin as typeof fetch }, auth: { persistSession: false } });
  vi.stubGlobal("caches", { default: {
    match: async (key: Request) => { const row = entries.get(key.url); return row && row.expires > Date.now() ? row.response.clone() : undefined; },
    put: async (key: Request, response: Response) => { entries.set(key.url, { response: new Response(await response.arrayBuffer(), response), expires: Date.now() + Number(/max-age=(\d+)/.exec(response.headers.get("cache-control")!)![1]) * 1000 }); },
  } });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
it("preserves public RPC output and avoids all three origin calls on warm profile/compare reuse", async () => {
  const read = () => Promise.all([getPublicSpeakingTimeStats(), getPublicSpeakingTimeByMeeting(1), getPublicSpeakingTimeByTopic(1)]);
  expect(await (await run(read)).json()).toEqual([ranking, meetings, topics]);
  expect(origin).toHaveBeenCalledTimes(3);
  expect((await run(read, { Cookie: "ph_phc_test_posthog=visitor" })).headers.get("X-Public-Data-Cache")).toBe("HIT");
  await run(() => Promise.all([getPublicSpeakingTimeStats(), getPublicSpeakingTimeByTopic(1)]));
  expect(origin).toHaveBeenCalledTimes(3);
  // Session-free aggregates are shared with signed-in visitors; credentials or an explicit refresh recompute.
  for (const headers of ([{ Cookie: "sb-project-auth-token=session" }, { Cookie: "unknown=value" }] as HeadersInit[])) {
    expect((await run(read, headers)).headers.get("X-Public-Data-Cache")).toBe("HIT");
  }
  expect(origin).toHaveBeenCalledTimes(3);
  for (const headers of ([{ Authorization: "Bearer synthetic" }, { Cookie: "sb-project-auth-token=session", "Cache-Control": "no-cache" }] as HeadersInit[])) await run(read, headers);
  expect(origin).toHaveBeenCalledTimes(9);
});
it("isolates every RPC filter and refreshes historical corrections at expiry or deployment", async () => {
  const historical = () => getPublicSpeakingTimeByTopic(1, "2020-01-01", "2020-12-31", 1);
  await run(historical);
  for (const args of [[2, "2020-01-01", "2020-12-31", 1], [1, "2020-02-01", "2020-12-31", 1], [1, "2020-01-01", "2020-11-30", 1], [1, "2020-01-01", "2020-12-31", 2]] as const) await run(() => getPublicSpeakingTimeByTopic(args[0], args[1], args[2], args[3]));
  expect(origin).toHaveBeenCalledTimes(5);
  vi.advanceTimersByTime(300_001); await run(historical); expect(origin).toHaveBeenCalledTimes(5);
  await run(() => getPublicSpeakingTimeByTopic(1)); vi.advanceTimersByTime(300_001); await run(() => getPublicSpeakingTimeByTopic(1)); expect(origin).toHaveBeenCalledTimes(7);
  vi.advanceTimersByTime(86_400_000); await run(historical); expect(origin).toHaveBeenCalledTimes(8);
  await run(historical, undefined, "corrected-deploy"); expect(origin).toHaveBeenCalledTimes(9);
});
it("retries RPC failures instead of caching the route's fallback", async () => {
  origin.mockResolvedValueOnce(Response.json({ message: "temporary failure", code: "XX000" }, { status: 500 }));
  await expect(run(() => getPublicSpeakingTimeStats())).rejects.toThrow("temporary failure");
  expect(entries.size).toBe(0);
  expect(await (await run(() => getPublicSpeakingTimeStats())).json()).toEqual(ranking);
  expect(origin).toHaveBeenCalledTimes(2);
});
