import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { beforeEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  person: { id: 25, name: "Alex Resident", slug: "alex-resident", memberships: [] as any[] },
  councilProfile: vi.fn(),
  stances: vi.fn(async () => []),
}));
vi.mock("../../app/lib/supabase.server", () => ({ getSupabaseAdminClient: () => ({
  from: () => { const q: any = { select: () => q, eq: () => q, single: async () => ({ data: state.person, error: null }) }; return q; },
}) }));
vi.mock("../../app/lib/people.server", () => ({ resolvePersonParam: async () => state.person }));
vi.mock("../../app/services/municipality", () => ({ getMunicipality: async () => ({ id: 1, slug: "langford" }) }));
vi.mock("../../app/services/council-terms", () => ({ getCouncilTerms: async () => [] }));
vi.mock("../../app/services/people", () => ({ getPersonProfile: (...args: any[]) => state.councilProfile(...args), getPublicParticipantStats: vi.fn() }));
vi.mock("../../app/services/council-summary.server", () => ({ getPublicPersonAttendance: async () => ({ total: 0, attended: 0, absent: 0, unknown: 0, verified: 0, recorded: 0, rate: null }) }));
vi.mock("../../app/services/profiling", () => ({
  getSpeakingTimeStats: async () => [], getSpeakingTimeByMeeting: async () => [], getSpeakingTimeByTopic: async () => [],
  getCouncillorStances: state.stances, getCouncillorHighlights: async () => null, getKeyVotes: async () => [],
}));
import { loader as councilLoader } from "../../app/routes/person-profile";
import ParticipantProfile from "../../app/routes/participant-profile";

beforeEach(() => {
  state.person = { id: 25, name: "Alex Resident", slug: "alex-resident", memberships: [] };
  state.councilProfile.mockReset().mockImplementation(async () => ({ person: state.person }));
  state.stances.mockClear();
});

it("redirects old public-person URLs before loading council analytics", async () => {
  let response: unknown;
  try { await councilLoader({ params: { id: "alex-resident" }, request: new Request("https://example.org/people/alex-resident"), context: {} } as any); }
  catch (error) { response = error; }
  expect(response).toBeInstanceOf(Response);
  expect((response as Response).headers.get("Location")).toBe("/participants/alex-resident");
  expect(state.councilProfile).not.toHaveBeenCalled();
  expect(state.stances).not.toHaveBeenCalled();
});

it("retains the council profile for a person with actual council service", async () => {
  state.person.memberships = [{ id: 1, organization_id: 1, role: "Councillor", start_date: "2022-11-07", organization: { classification: "Council", name: "Council" } }];
  const data = await councilLoader({ params: { id: "alex-resident" }, request: new Request("https://example.org/people/alex-resident"), context: {} } as any);
  expect(data.person.id).toBe(25);
  expect(state.stances).toHaveBeenCalled();
});

it("shows a public participant's appearances without council-only labels or analytics", () => {
  const appearance = { meetingId: 10, meetingDate: "2024-01-01", meetingTitle: "Council meeting", agendaItemId: null, seconds: 42, segmentCount: 1, firstStartTime: 10 };
  const html = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(ParticipantProfile, { loaderData: {
    person: state.person, hasCouncilService: false, history: null, participation: {
      meetingCount: 1, documentedMeetingCount: 0, totalSeconds: 42, recentAppearances: [appearance],
    },
    statements: [], audioOnly: [appearance], summary: { meetingCount: 1, agendaItemCount: 0, firstDate: "2024-01-01", lastDate: "2024-01-01" },
  } } as any)));
  expect(html).toContain("Public participant");
  expect(html).toContain("/meetings/10?t=10");
  expect(html).not.toMatch(/Former|Recorded votes|Voting alignment|Attendance rate|Key votes|Policy|council service profile/i);
});

it("lists linked comments newest first with item anchors, matter links and positions, never the street qualifier", () => {
  const statement = (agendaItemId: number, meetingDate: string, extra: object = {}) => ({
    agendaItemId, agendaTitle: "PUBLIC PARTICIPATION", meetingId: agendaItemId * 10, meetingSlug: `${meetingDate}-regular-council`,
    meetingTitle: "Regular Council", meetingDate, matter: null, position: "supports", topic: "Waste management",
    point: "Supports a municipal garbage contract.", source: null, audio: null, ...extra,
  });
  const html = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(ParticipantProfile, { loaderData: {
    person: state.person, hasCouncilService: false, history: null, participation: null, audioOnly: [],
    statements: [
      statement(7, "2025-12-15", { matter: { id: 3, slug: "zoning-bylaw-2100", title: "Zoning Bylaw 2100" }, audio: { seconds: 75, firstStartTime: 300.6 } }),
      statement(5, "2022-09-06", { position: "opposes", topic: "Dust bylaw", point: "Opposes dust.", source: "minutes" }),
    ],
    summary: { meetingCount: 2, agendaItemCount: 2, firstDate: "2022-09-06", lastDate: "2025-12-15" },
  } } as any)));
  expect(html).toContain("Public participant");
  expect(html).not.toContain("No public comments");
  expect(html).toContain("/meetings/2025-12-15-regular-council#item-7");
  expect(html).toContain("/matters/zoning-bylaw-2100");
  expect(html).toContain("/meetings/2025-12-15-regular-council?t=300");
  expect(html).toContain("Supports");
  expect(html).toContain("Opposes");
  expect(html).toContain("From the minutes");
  expect(html.indexOf("item-7")).toBeLessThan(html.indexOf("item-5"));
  expect(html).not.toContain("Recorded audio appearances");
});

it("explains the empty state", () => {
  const html = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(ParticipantProfile, { loaderData: {
    person: state.person, hasCouncilService: false, history: null, participation: null, statements: [], audioOnly: [],
    summary: { meetingCount: 0, agendaItemCount: 0, firstDate: null, lastDate: null },
  } } as any)));
  expect(html).toContain("No public comments or appearances have been linked to Alex Resident");
});
