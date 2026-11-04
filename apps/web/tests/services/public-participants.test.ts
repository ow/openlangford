import { expect, it } from "vitest";
import { getPublicParticipantStats, getParticipantIdentificationCoverage } from "../../app/services/people";
import { civicToday } from "../../app/lib/council-terms";

// public_participant_appearances as the SQL defines it (grouping, ordering and
// filters); the Postgres test checks the real function against the same rules.
function appearancesFromSegments(segments: any[], { p_today, p_municipality_id, p_person_id }: any) {
  const groups = new Map<string, any>();
  for (const s of [...segments].sort((a, b) => a.id - b.id)) {
    const m = s.meetings;
    if (s.person_id == null || (p_person_id != null && s.person_id !== p_person_id) || !m || m.meeting_date > p_today ||
      (p_municipality_id != null && m.municipality_id !== p_municipality_id) ||
      !(s.end_time > s.start_time) || !(s.end_time - s.start_time < Infinity)) continue;
    const key = `${s.person_id}:${s.meeting_id}:${s.agenda_item_id ?? null}`;
    const group = groups.get(key);
    if (group) {
      group.seconds += s.end_time - s.start_time; group.segments += 1; group.first_start = Math.min(group.first_start, s.start_time);
    } else {
      groups.set(key, { person_id: s.person_id, meeting_id: s.meeting_id, agenda_item_id: s.agenda_item_id ?? null,
        seconds: s.end_time - s.start_time, segments: 1, first_start: s.start_time, meeting_slug: m.slug ?? null,
        meeting_title: m.title ?? null, meeting_date: m.meeting_date, municipality_id: m.municipality_id ?? null,
        organization_id: m.organization_id ?? null, agenda_title: s.agenda_items?.title ?? null, category: s.agenda_items?.category ?? null });
    }
  }
  return [...groups.values()];
}

// A small relational store: filters apply to source rows, including the real
// PostgREST row cap. It supplies no computed participant classifications.
function client(segments: any[], people: any[], meetings: any[] = [], calls: string[] = []) {
  return { rpc(name: string, args: any) {
    calls.push(`rpc:${name}`);
    if (name !== "public_participant_appearances") throw new Error(`unexpected rpc ${name}`);
    return Promise.resolve({ data: appearancesFromSegments(segments, args), error: null });
  }, from(table: string) {
    calls.push(table);
    let rows = table === "people" ? [...people] : table === "meetings" ? [...meetings] : [...segments];
    let start = 0, end = 999, head = false;
    const value = (row: any, key: string) => key.split(".").reduce((r, k) => r?.[k], row);
    const query: any = {
      select(_columns: string, options?: { head?: boolean }) { head = !!options?.head; return query; },
      not(key: string, _op: string, v: any) { rows = rows.filter(r => value(r, key) !== v); return query; },
      eq(key: string, v: any) { rows = rows.filter(r => value(r, key) === v); return query; },
      lte(key: string, v: any) { rows = rows.filter(r => value(r, key) <= v); return query; },
      in(key: string, values: any[]) { rows = rows.filter(r => values.includes(value(r, key))); return query; },
      order(key: string) { rows.sort((a, b) => value(a, key) - value(b, key)); return query; },
      range(a: number, b: number) { start = a; end = b; return query; },
      then(resolve: any) { return Promise.resolve({ data: head ? null : rows.slice(start, end + 1), count: head ? rows.length : null, error: null }).then(resolve); },
    };
    return query;
  }} as any;
}
const membership = (role: string, start_date: string, end_date: string | null, classification: string) =>
  ({ role, start_date, end_date, organization: { classification } });
const segment = (id: number, person_id: number, date: string, municipality_id = 1) => ({
  id, person_id, meeting_id: id, start_time: 0, end_time: 60,
  meetings: { id, title: "Council", meeting_date: date, municipality_id },
});

it("measures named-link coverage against all scoped transcript segments, including unidentified speech", async () => {
  const rows = [segment(1, 1, "2024-01-01"), segment(2, null as any, "2024-01-01"),
    segment(3, null as any, "2024-01-01"), segment(4, 2, "2024-01-01", 2), segment(5, 1, "2099-01-01")];
  expect(await getParticipantIdentificationCoverage(client(rows, []), 1)).toEqual({ totalSegments: 3, linkedSegments: 1 });
  expect(await getParticipantIdentificationCoverage(client([], []), 1)).toEqual({ totalSegments: 0, linkedSegments: 0 });
});

it("counts public speech outside dated council/staff service, never future or anonymous identities", async () => {
  const people = [
    { id: 1, name: "Future Councillor", is_councillor: true, memberships: [membership("Councillor", "2025-01-01", "2025-12-31", "Council")] },
    { id: 2, name: "Former Clerk", memberships: [membership("Clerk", "2020-01-01", "2022-12-31", "STAFF")] },
    { id: 3, name: "Unknown Speaker", memberships: [] },
    { id: 4, name: "Resident Example", memberships: [] },
    { id: 5, name: "Undated Councillor", is_councillor: true, memberships: [] },
  ];
  const rows = [segment(1, 1, "2024-06-01"), segment(2, 1, "2025-06-01"), segment(3, 1, "2026-01-01"),
    segment(4, 2, "2021-06-01"), segment(5, 2, "2024-06-01"), segment(6, 3, "2024-06-01"),
    segment(7, 4, "2099-01-01"), segment(8, 4, "2024-06-01", 2), segment(9, 5, "2024-06-01")];
  const result = await getPublicParticipantStats(client(rows, people), 1);
  expect(result.map(p => [p.person.id, p.meetingCount, p.totalSeconds])).toEqual([[1, 2, 120], [2, 1, 60]]);
});

it("unions minutes-confirmed and audio appearances without inventing speaking time or double-counting meetings", async () => {
  const person = { id: 353, name: "Lisa Foxall", is_councillor: true,
    memberships: [membership("Councillor", "2026-11-02", null, "Council")] };
  const history = [{ personId: 353, municipalitySlug: "langford", name: "Lisa Foxall", coverageNote: "Two original minutes.", records: [
    { meetingId: 1, date: "2024-01-01", meetingType: "Council", minutesUrl: "https://example.org/1.pdf", recordingUrl: "", summary: "Public question." },
    { meetingId: 2, date: "2024-02-01", meetingType: "Council", minutesUrl: "https://example.org/2.pdf", recordingUrl: "", summary: "Public comment." },
  ] }];
  const rows = [segment(1, 353, "2024-01-01")];
  const result = await (getPublicParticipantStats as any)(client(rows, [person]), 1, history);
  expect(result).toHaveLength(1);
  expect(result[0]).toMatchObject({ meetingCount: 2, audioMeetingCount: 1, documentedMeetingCount: 2, totalSeconds: 60, segmentCount: 1 });
  const minutesOnly = await (getPublicParticipantStats as any)(client([], [person]), 1, history);
  expect(minutesOnly[0]).toMatchObject({ meetingCount: 2, audioMeetingCount: 0, documentedMeetingCount: 2, totalSeconds: 0, segmentCount: 0 });
  expect(minutesOnly[0].recentAppearances[0]).toMatchObject({ meetingId: 2, minutesUrl: "https://example.org/2.pdf" });
});

it.each(["government_staff", "committee_member"])("excludes documented %s service only at the meeting where the role is established", async (classification) => {
  const presenter = { id: 25, name: "Example Presenter", memberships: [] };
  const role = { person_id: 25, classification, role: "Senior Manager", organization: "Regional District",
    observed_date: "2024-01-01", source_file: "archive/minutes.pdf", source_sha256: "a".repeat(64),
    source_url: "https://example.org/minutes.pdf", source_quote: "Senior Manager Example Presenter provided a presentation.",
    method: "official_minutes_explicit_role_v1" };
  const rows = [segment(1, 25, "2024-01-01"), segment(2, 25, "2024-02-01")];
  const result = await getPublicParticipantStats(client(rows, [presenter], [{ id: 1, participant_roles: { 25: role } }]), 1);
  expect(result.map(p => [p.person.id, p.meetingCount, p.totalSeconds])).toEqual([[25, 1, 60]]);
  expect(result[0].recentAppearances.map(a => a.meetingId)).toEqual([2]);
});

it("scopes a participant profile to one person and returns their complete public appearance history", async () => {
  const people = [{ id: 25, name: "Alex Resident", memberships: [] }, { id: 26, name: "Other Resident", memberships: [] }];
  const rows = Array.from({ length: 8 }, (_, i) => segment(i + 1, 25, "2024-01-01"));
  rows.push(segment(9, 26, "2024-01-01"));
  const result = await getPublicParticipantStats(client(rows, people), 1, [], 25);
  expect(result.map(p => p.person.id)).toEqual([25]);
  expect(result[0].recentAppearances).toHaveLength(8);
});

it("keeps a committee member's public comments while excluding only their dated service on that specific committee", async () => {
  const citizen = { id: 25, name: "Example Committee Member", memberships: [
    { ...membership("Citizen Representative", "2023-01-01", "2024-12-31", "Committee"), organization_id: 9 },
  ] };
  const rows = [
    { ...segment(1, 25, "2024-01-01"), meetings: { ...segment(1, 25, "2024-01-01").meetings, organization_id: 9 } },
    { ...segment(2, 25, "2024-01-01"), meetings: { ...segment(2, 25, "2024-01-01").meetings, organization_id: 1 } },
    { ...segment(3, 25, "2024-01-01"), meetings: { ...segment(3, 25, "2024-01-01").meetings, organization_id: 18 } },
    { ...segment(4, 25, "2025-01-01"), meetings: { ...segment(4, 25, "2025-01-01").meetings, organization_id: 9 } },
  ];
  const result = await getPublicParticipantStats(client(rows, [citizen]), 1);
  expect(result[0]).toMatchObject({ meetingCount: 3, totalSeconds: 180 });
  expect(result[0].recentAppearances.map(a => a.meetingId).sort()).toEqual([2, 3, 4]);
});

it("lists people known only through linked comments or letters, counting meetings and items once with audio", async () => {
  const people = [{ id: 1, name: "Audio Speaker", memberships: [] }, { id: 19, name: "Tanya Sunshine", memberships: [] }];
  const statement = (meetingId: number, agendaItemId: number, kind: "spoken" | "written", date = "2024-01-01") => ({
    agendaItemId, agendaTitle: "Rezoning", meetingId, meetingSlug: `m-${meetingId}`, meetingTitle: "Council", meetingDate: date,
    matter: null, position: "opposes", topic: "Height", point: "Opposes the height.", source: null, kind, documentId: kind === "written" ? 44 : null,
  });
  const audio = { ...segment(1, 1, "2024-01-01"), agenda_item_id: 10 };
  const linked = new Map([
    // Same meeting and item as the audio: no new meeting or item.
    [1, [statement(1, 10, "spoken"), statement(1, 10, "written")]],
    // Comment and letter on the same item, plus a letter at another meeting; a future one is ignored.
    [19, [statement(3, 30, "spoken", "2024-03-01"), statement(3, 30, "written", "2024-03-01"), statement(4, 40, "written", "2024-04-01"), statement(5, 50, "written", "2099-01-01")]],
  ]);
  const result = await (getPublicParticipantStats as any)(client([audio], people), 1, [], undefined, linked);
  expect(result.map((p: any) => [p.person.id, p.meetingCount, p.agendaItemCount, p.commentCount, p.letterCount, p.totalSeconds]))
    .toEqual([[1, 1, 1, 1, 1, 60], [19, 2, 2, 1, 2, 0]]);
  const tanya = result[1];
  expect(tanya.lastSpokeAt).toBe("2024-04-01");
  expect(tanya.recentAppearances.map((a: any) => [a.meetingId, a.agendaItemId, a.kind])).toEqual([[4, 40, "written"], [3, 30, "spoken"], [3, 30, "written"]]);
  // The audio appearance already covers person 1's comment; the letter still shows.
  expect(result[0].recentAppearances.map((a: any) => a.kind ?? "audio")).toEqual(["audio", "written"]);
});

it("reads grouped appearances in one call and totals them as it totalled their segments", async () => {
  const people = [{ id: 7, name: "Pat Resident", memberships: [] }];
  const item = (id: number, category: string | null) => ({ id, title: `Item ${id}`, category });
  const meeting = (id: number, date: string) => ({ id, slug: `m-${id}`, title: `Council ${id}`, meeting_date: date, municipality_id: 1, organization_id: 1 });
  const seg = (id: number, meetingId: number, date: string, agenda: any, start: number, end: number) => ({
    id, person_id: 7, meeting_id: meetingId, agenda_item_id: agenda?.id ?? null, start_time: start, end_time: end,
    meetings: meeting(meetingId, date), agenda_items: agenda });
  const rezoning = item(10, "Land Use"), budget = item(11, "Finance"), untitled = item(12, null);
  const rows = [
    seg(1, 1, "2024-01-01", rezoning, 300.5, 360.25), seg(2, 1, "2024-01-01", budget, 120, 150),
    seg(3, 1, "2024-01-01", rezoning, 200.125, 230), seg(4, 1, "2024-01-01", rezoning, 400, 400),
    seg(5, 2, "2024-02-01", null, 10, 25.5), seg(6, 2, "2024-02-01", untitled, 50, 40), seg(7, 2, "2024-02-01", untitled, 60, 61),
  ];
  const calls: string[] = [];
  const [stats] = await getPublicParticipantStats(client(rows, people, [], calls), 1, [], 7);
  expect(calls.filter(c => c.startsWith("rpc:") || c === "transcript_segments")).toEqual(["rpc:public_participant_appearances"]);
  expect(stats).toMatchObject({ totalSeconds: 59.75 + 30 + 29.875 + 15.5 + 1, segmentCount: 5, meetingCount: 2, audioMeetingCount: 2,
    agendaItemCount: 3, firstSpokeAt: "2024-01-01", lastSpokeAt: "2024-02-01" });
  expect(stats.topCategories).toEqual([
    { category: "Land Use", seconds: 89.625, count: 2 }, { category: "Finance", seconds: 30, count: 1 }, { category: "Public", seconds: 16.5, count: 2 }]);
  expect(stats.recentAppearances.map(a => [a.meetingId, a.agendaItemId, a.agendaTitle, a.category, a.seconds, a.segmentCount, a.firstStartTime])).toEqual([
    [2, null, null, "Public", 15.5, 1, 10], [2, 12, "Item 12", "Public", 1, 1, 60],
    [1, 11, "Item 11", "Finance", 30, 1, 120], [1, 10, "Item 10", "Land Use", 89.625, 2, 200.125]]);
  expect(stats.recentAppearances[0]).toMatchObject({ meetingSlug: "m-2", meetingTitle: "Council 2", meetingDate: "2024-02-01" });
});

it("passes today's civic date, the municipality and the person to the appearances query", async () => {
  const args: any[] = [];
  const recorder = { rpc(_name: string, a: any) { args.push(a); return Promise.resolve({ data: [], error: null }); } } as any;
  await getPublicParticipantStats(recorder, 1, [], 25);
  await getPublicParticipantStats(recorder);
  expect(args).toEqual([{ p_today: civicToday(), p_municipality_id: 1, p_person_id: 25 }, { p_today: civicToday(), p_municipality_id: null, p_person_id: null }]);
  const failing = { rpc: () => Promise.resolve({ data: null, error: new Error("statement timeout") }) } as any;
  await expect(getPublicParticipantStats(failing, 1)).rejects.toThrow("statement timeout");
});

it("attaches a minutes record to the meeting's first-heard appearance, as segment order did", async () => {
  const person = { id: 8, name: "Sam Resident", memberships: [] };
  const meeting = { id: 1, slug: "m-1", title: "Council", meeting_date: "2024-01-01", municipality_id: 1 };
  // Segment 1 is on the later agenda item, so its appearance was met first.
  const rows = [
    { id: 1, person_id: 8, meeting_id: 1, agenda_item_id: 21, start_time: 900, end_time: 960, meetings: meeting, agenda_items: { title: "Later", category: "A" } },
    { id: 2, person_id: 8, meeting_id: 1, agenda_item_id: 20, start_time: 100, end_time: 160, meetings: meeting, agenda_items: { title: "Earlier", category: "A" } },
  ];
  const history = [{ personId: 8, municipalitySlug: "langford", name: "Sam Resident", coverageNote: "", records: [
    { meetingId: 1, date: "2024-01-01", meetingType: "Council", minutesUrl: "https://example.org/1.pdf", recordingUrl: "", summary: "Spoke." }] }];
  const [stats] = await (getPublicParticipantStats as any)(client(rows, [person]), 1, history);
  expect(stats.recentAppearances.map((a: any) => [a.agendaItemId, a.minutesUrl ?? null])).toEqual([[20, null], [21, "https://example.org/1.pdf"]]);
  expect(stats).toMatchObject({ meetingCount: 1, documentedMeetingCount: 1, audioMeetingCount: 1 });
});
