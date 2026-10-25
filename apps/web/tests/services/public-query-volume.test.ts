import { createClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { withPublicDataCache } from "../../app/services/public-data-cache.server";
import { getMeetings } from "../../app/services/meetings";
import { getPersonProfile } from "../../app/services/people";
import { getPublicPersonAttendance } from "../../app/services/council-summary.server";
import { getPublicCouncilComparisonPeople, getPublicCouncilSummary } from "../../app/services/council-summary.server";
import type { Municipality } from "../../app/lib/types";
const { origin } = vi.hoisted(() => ({ origin: vi.fn() }));
const client = () => createClient("https://origin.supabase.co", "public-test-key", { global: { fetch: origin }, auth: { persistSession: false } });
vi.mock("../../app/lib/supabase.server", () => ({ getSupabaseAdminClient: () => client() }));
const member = { id: 1, name: "Member", memberships: [{ id: 1, organization_id: 10, role: "Councillor", start_date: "2026-01-01", organization: { classification: "Council" } }] };
const meetings = [1, 2, 3].map(id => ({ id, organization_id: 10, meeting_date: `2026-01-0${id}`, has_agenda: true, status: "Completed" }));
let transferred = 0;
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-21T12:00:00Z")); transferred = 0; origin.mockReset();
  origin.mockImplementation(async (input: string | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input.url); const table = url.pathname.split("/").pop(); let rows: any;
    if (table === "organizations") rows = { id: 10 };
    else if (table === "people") rows = url.searchParams.has("id") ? member : [member];
    else if (table === "meetings") rows = meetings;
    else if (table === "council_terms") rows = [{ id: 1, name: "Term", start_date: "2026-01-01", end_date: "2026-11-01" }, { id: 2, name: "Next term", start_date: "2026-11-02", end_date: "2030-11-01" }];
    else if (table === "council_attendance_summaries") {
      expect(JSON.parse(String(init?.body))).toEqual({ p_municipality_id: 1, p_as_of: "2026-10-21" });
      rows = [{ person_id: 1, term_key: "all", total: 3, attended: 1, absent: 0, unknown: 2, verified: 0, recorded: 1, rate: 33 }, { person_id: 1, term_key: "1", total: 3, attended: 1, absent: 0, unknown: 2, verified: 0, recorded: 1, rate: 33 },
        { person_id: 1, term_key: "2", total: 0, attended: 0, absent: 0, unknown: 0, verified: 0, recorded: 0, rate: null }];
    } else if (table === "get_meetings_with_stats") {
      expect(JSON.parse(String(init?.body)).filter_municipality_id).toBe(1);
      const filter = url.searchParams.get("meeting_id");
      const ids = filter ? filter.slice(4, -1).split(",").map(Number) : Array.from({ length: 500 }, (_, i) => i + 1);
      rows = ids.map(id => ({ meeting_id: id, motion_carried_count: 1, motion_defeated_count: 0, motion_other_count: 0, topics: ["Finance"] }));
    } else if (table === "attendance") {
      expect(url.searchParams.get("person_id")).toBe("eq.1");
      const offset = Number(url.searchParams.get("offset") || 0), limit = Number(url.searchParams.get("limit") || 0);
      expect(limit).toBe(20); // Only the evidence page actually displayed, never all history.
      rows = Array.from({ length: Math.min(limit, 41 - offset) }, (_, i) => ({ id: offset + i + 1, person_id: 1, meeting_id: offset + i + 1,
        attendance_mode: "In Person", notes: "", meetings: { meeting_date: "2026-01-01", title: `Meeting ${offset + i + 1}` } }));
    } else if (table === "agenda_items") {
      // Letter counts: only items with written participation come back.
      rows = [{ meeting_id: 2, written: { documents: [{ extracted_document_id: 1, document_id: 1, letters: [{ who: "A", position: "supports", topic: "t", point: "p" }] }] } }];
    } else if (["votes", "motions", "transcript_segments", "candidacies", "memberships"].includes(table!)) rows = [];
    else throw new Error(`Unexpected table ${table}`);
    transferred += JSON.stringify(rows).length; return Response.json(rows, { headers: { "Content-Range": table === "attendance" ? "0-19/41" : "*/0" } });
  });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
it("transfers only selected meeting stats rather than all municipal history", async () => {
  const result = await getMeetings(client(), { id: 1 } as Municipality, { startDate: "2026-01-01", endDate: "2026-12-31" });
  expect(Object.keys(result.statsMap)).toEqual(["1", "2", "3"]); expect(result.statsMap[1].motion_carried_count).toBe(1);
  expect(result.statsMap[2].letter_count).toBe(1); expect(result.statsMap[1].letter_count).toBeUndefined();
  expect(transferred).toBeLessThan(2000); expect(result.statsComplete).toBe(true);
});
it("loads compact SQL attendance summaries without fetching meeting or attendance history", async () => {
  const summary = await getPublicCouncilSummary(1);
  expect(summary.stats["1"][1]).toEqual({ total: 3, attended: 1, absent: 0, unknown: 2, verified: 0, recorded: 1, rate: 33 });
  expect(summary.stats["2"][1].total).toBe(0);
  expect(transferred).toBeLessThan(2000);
  const paths = origin.mock.calls.map(([input]) => new URL(typeof input === "string" ? input : input.url).pathname);
  expect(paths.some(path => /\/(attendance|meetings)$/.test(path))).toBe(false);
  expect(paths).toHaveLength(4);
});

it("warm council browsing makes zero Supabase calls, while authenticated requests bypass shared values", async () => {
  const entries = new Map<string, Response>(); const jobs: Promise<unknown>[] = [];
  vi.stubGlobal("caches", { default: { match: async (key: Request) => entries.get(key.url)?.clone(), put: async (key: Request, response: Response) => { entries.set(key.url, new Response(await response.arrayBuffer(), response)); } } });
  const run = (headers?: HeadersInit) => withPublicDataCache({ version: "test-council-deploy", request: new Request("https://openlangford.ca/people.data?_routes=routes%2Fpeople", { headers }), waitUntil: p => jobs.push(p) }, async () => Response.json(await getPublicCouncilSummary(1)));
  const cold = await run(); await Promise.all(jobs); const calls = origin.mock.calls.length; const bytes = transferred;
  expect(calls).toBeGreaterThan(0); expect(bytes).toBeLessThan(2000);
  const warm = await run(); expect(await warm.text()).toBe(await cold.text()); expect(warm.headers.get("X-Public-Data-Cache")).toBe("HIT");
  expect(origin).toHaveBeenCalledTimes(calls); expect(transferred).toBe(bytes);
  await run({ Cookie: "sb-test-auth-token=session" }); expect(origin.mock.calls.length).toBeGreaterThan(calls);
});
it("fails unavailable SQL summaries instead of inventing or caching zero attendance", async () => {
  const normal = origin.getMockImplementation()!;
  origin.mockImplementation(async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    return url.pathname.endsWith("council_attendance_summaries") ? Response.json({ message: "Missing migration", code: "PGRST202" }, { status: 404 }) : normal(input, init);
  });
  await expect(getPublicCouncilSummary(1)).rejects.toMatchObject({ code: "PGRST202" });
});

it("reuses council totals for comparison and individual all-service/term counts without another origin call", async () => {
  const entries = new Map<string, Response>(); const jobs: Promise<unknown>[] = [];
  vi.stubGlobal("caches", { default: { match: async (key: Request) => entries.get(key.url)?.clone(), put: async (key: Request, response: Response) => { entries.set(key.url, new Response(await response.arrayBuffer(), response)); } } });
  const run = <T,>(compute: () => Promise<T>) => withPublicDataCache({ version: "cross-surface", request: new Request("https://openlangford.ca/people"), waitUntil: p => jobs.push(p) }, async () => Response.json(await compute()));
  await run(() => getPublicCouncilSummary(1)); await Promise.all(jobs); const calls = origin.mock.calls.length;
  const compare = await (await run(() => getPublicCouncilComparisonPeople(1))).json() as any;
  const all = await (await run(() => getPublicPersonAttendance(1, 1))).json();
  const futureTerm = await (await run(() => getPublicPersonAttendance(1, 1, 2))).json() as any;
  expect(compare[0].stats).toEqual(all); expect(futureTerm.total).toBe(0); expect(origin).toHaveBeenCalledTimes(calls);
});
it.each([0, 1])("keeps the displayed profile evidence page %i with SQL totals and no bulk history transfer", async page => {
  const summary = await getPublicPersonAttendance(1, 1, 1);
  const data = await getPersonProfile(client(), "1", page, 1, { start: "2026-01-01", end: "2026-10-21" }, summary);
  expect(data.attendanceSummary).toEqual(summary); expect(data.attendance).toHaveLength(20); expect(data.attendance[0].id).toBe(page * 20 + 1);
  expect(data.attendanceTotal).toBe(41); expect(data).not.toHaveProperty("attendanceAll"); expect(data).not.toHaveProperty("allMeetings");
  const requests = origin.mock.calls.map(([input]) => new URL(typeof input === "string" ? input : input.url));
  expect(requests.filter(url => url.pathname.endsWith("/attendance"))).toHaveLength(1);
  const detail = requests.find(url => url.pathname.endsWith("/attendance"))!;
  expect(detail.searchParams.get("meetings.meeting_date")).toBe("lte.2026-10-21");
  expect(detail.searchParams.get("or") || detail.searchParams.get("meetings.or")).toContain("2026-01-01");
  expect(requests.some(url => url.pathname.endsWith("/meetings"))).toBe(false);
});

it("does not retain a partial member-term map and recovers immediately when origin is complete", async () => {
  const entries = new Map<string, Response>(); const jobs: Promise<unknown>[] = [];
  vi.stubGlobal("caches", { default: { match: async (key: Request) => entries.get(key.url)?.clone(), put: async (key: Request, response: Response) => { entries.set(key.url, new Response(await response.arrayBuffer(), response)); } } });
  const normal = origin.getMockImplementation()!; let partial = true;
  origin.mockImplementation(async (input, init) => {
    const response = await normal(input, init);
    const url = new URL(typeof input === "string" ? input : input.url);
    if (partial && url.pathname.endsWith("council_attendance_summaries")) return Response.json((await response.json() as any[]).filter(row => row.term_key !== "1"));
    return response;
  });
  const run = () => withPublicDataCache({ version: "partial-recovery", request: new Request("https://openlangford.ca/people"), waitUntil: p => jobs.push(p) }, async () => Response.json(await getPublicPersonAttendance(1, 1, 1)));
  await expect(run()).rejects.toThrow("Incomplete council attendance summary"); await Promise.all(jobs);
  partial = false;
  expect((await (await run()).json() as any).total).toBe(3);
  expect(origin.mock.calls.filter(([input]) => String(typeof input === "string" ? input : input.url).includes("council_attendance_summaries"))).toHaveLength(2);
});
