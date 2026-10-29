import { createElement as h } from "react";
import { renderToStaticMarkup as markup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { expect, it, vi } from "vitest";
vi.mock("../../app/lib/supabase.server", () => ({
  getSupabaseAdminClient: vi.fn(),
}));
vi.mock("../../app/services/municipality", () => ({ getMunicipality: async () => ({ id: 1 }) }));
vi.mock("../../app/services/meetings", async importOriginal => ({ ...await importOriginal<any>(),
  getMeetings: async () => ({ meetings: [], statsMap: {}, statsComplete: true }),
  getMeetingDateBounds: async () => ({ earliest: "2016-01-01", latest: "2026-01-01" }),
}));
import { withPublicDataCache } from "../../app/services/public-data-cache.server";
import Meetings, { shouldRevalidate, loader } from "../../app/routes/meetings";
import { MeetingAttendance } from "../../app/components/meeting/MeetingSidebar";
import { AgendaOverview } from "../../app/components/meeting/AgendaOverview";
import { meetingPeriod } from "../../app/lib/meeting-period";
const data = {
  meetings: [],
  statsMap: {},
  selectedYear: 2026,
  currentYear: 2026,
  bounds: { earliest: "2023-03-06", latest: "2026-05-19" },
  loadError: false,
};
function render(url: string, overrides = {}) {
  return markup(
    h(
      MemoryRouter,
      { initialEntries: [url] },
      h(Meetings, { loaderData: { ...data, ...overrides } } as any),
    ),
  );
}
function destination(html: string, label: string) {
  const href = [
    ...html.matchAll(/<a[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/g),
  ].find((m) => m[2].includes(label))?.[1];
  return href
    ? new URL(href.replaceAll("&amp;", "&"), "https://example.org/meetings")
    : null;
}
it("browses earlier years from default, preserves filters repeatedly, and stops at available data", () => {
  let url = "/meetings?type=Committee&q=budget&sort=asc&extra=keep";
  for (const year of [2025, 2024, 2023]) {
    const next = destination(
      render(url, { selectedYear: year + 1 }),
      "Previous meetings",
    )!;
    expect(next.searchParams.get("year")).toBe(String(year));
    for (const [key, value] of Object.entries({
      type: "Committee",
      q: "budget",
      sort: "asc",
      extra: "keep",
    }))
      expect(next.searchParams.get(key)).toBe(value);
    url = next.pathname + next.search;
  }
  const html = render(url, { selectedYear: 2023 });
  expect(destination(html, "Previous meetings")).toBeNull();
  expect(html).toContain("Available meeting records begin in March 2023");
  expect(destination(html, "Newer meetings")?.searchParams.get("year")).toBe(
    "2024",
  );
});
it("deep links calendar months across year rollover and empty periods in both directions", () => {
  const january = render(
    "/meetings?view=calendar&year=2025&month=1&type=Council",
    { selectedYear: 2025 },
  );
  const previous = destination(january, "Previous meetings")!;
  expect(previous.searchParams.get("year")).toBe("2024");
  expect(previous.searchParams.get("month")).toBe("12");
  expect(previous.searchParams.get("type")).toBe("Council");
  const december = render(previous.pathname + previous.search, {
    selectedYear: 2024,
  });
  expect(december).toContain("Showing December 2024");
  const newer = destination(december, "Newer meetings")!;
  expect(newer.searchParams.get("year")).toBe("2025");
  expect(newer.searchParams.get("month")).toBe("1");
  expect(
    render(newer.pathname + newer.search, { selectedYear: 2025 }),
  ).toContain("Showing January 2025");
});
it("does not promise earlier records at the earliest month, without data, or on load failure", () => {
  expect(
    destination(
      render("/meetings?view=calendar&year=2023&month=3", {
        selectedYear: 2023,
      }),
      "Previous meetings",
    ),
  ).toBeNull();
  expect(render("/meetings", { bounds: {} })).toContain(
    "No meeting history is available yet",
  );
  expect(
    destination(render("/meetings", { bounds: {} }), "Previous meetings"),
  ).toBeNull();
  const failed = render("/meetings", { bounds: null, loadError: true });
  expect(failed).toContain("Meetings could not be loaded");
  expect(failed).not.toContain("No meeting history is available yet");
  expect(render("/meetings", { bounds: null, loadError: false })).toContain(
    "History availability could not be loaded",
  );
});
it("reloads annual data for forward and back year transitions, but not same-year months", () => {
  const check = (a: string, b: string) =>
    shouldRevalidate({
      currentUrl: new URL(a, "https://example.org"),
      nextUrl: new URL(b, "https://example.org"),
    } as any);
  expect(
    check("/meetings?year=2025&month=1", "/meetings?year=2024&month=12"),
  ).toBe(true);
  expect(
    check("/meetings?year=2024&month=12", "/meetings?year=2025&month=1"),
  ).toBe(true);
  expect(
    check(
      "/meetings?year=2025&month=1",
      "/meetings?year=2025&month=2&q=budget",
    ),
  ).toBe(false);
});
it.each([0, 1, 5])(
  "labels %i verified attendees without changing the participant count",
  (count) => {
    const council = Array.from({ length: 6 }, (_, id) => ({
      id,
      resolvedName: `Member ${id}`,
      isParticipant: id < count,
    }));
    const html = markup(
      h(
        MemoryRouter,
        null,
        h(MeetingAttendance, {
          attendanceGroups: { council, staff: [], others: [] },
          speakerStats: { stats: {}, totalTime: 0 },
          getPersonRole: () => null,
          formatDuration: String,
        }),
      ),
    );
    expect(html).toContain(
      `${count} verified ${count === 1 ? "attendee" : "attendees"}`,
    );
  },
);
it("shows official motion title and outcome without its synthetic order in the number column", () => {
  const html = markup(
    h(
      MemoryRouter,
      null,
      h(AgendaOverview, {
        items: [
          {
            id: 51,
            item_order: "official-recorded-motions",
            title: "Official recorded motions",
            motions: [
              { id: 41, result: "CARRIED", text_content: "Adopt minutes" },
            ],
          },
        ] as any,
        expandedItemId: null,
        onItemClick: vi.fn(),
        onWatchVideo: vi.fn(),
        meetingId: 77,
      }),
    ),
  );
  expect(html).toContain("Official recorded motions");
  expect(html).toContain("Carried");
  expect(html).not.toContain("official-recorded-motions");
});

it.each(["", "year=all", "year=garbage", "year=2025oops", "year=0001"])(
  'treats unsupported/default year "%s" as the current year',
  (query) => {
    expect(
      meetingPeriod(new URLSearchParams(query), new Date(2026, 9, 20)),
    ).toEqual({ year: 2026, month: 10, monthly: false });
  },
);
it("counts only matching meetings in the visible calendar month", () => {
  const html = render("/meetings?view=calendar&year=2025&month=1&q=budget", {
    selectedYear: 2025,
    meetings: [
      { id: 1, title: "Budget", meeting_date: "2025-01-13" },
      { id: 2, title: "Budget", meeting_date: "2025-02-03" },
    ],
  });
  expect(html).toMatch(/>1<\/span> result/);
});

it.each([["2026-01-05T12:00:00Z", 300], ["2026-02-05T12:00:00Z", 86400]] as const)("keeps prior-year data short-lived until every possible meeting is historical at %s", async (date, expectedTTL) => {
  vi.useFakeTimers(); vi.setSystemTime(new Date(date));
  const stored = new Map<string, string>(); const jobs: Promise<unknown>[] = [];
  vi.stubGlobal("caches", { default: { match: async () => undefined, put: async (key: Request, response: Response) => { stored.set(key.url, response.headers.get("X-Fresh-For")!); } } });
  try {
    const request = new Request("https://openlangford.ca/meetings?year=2025");
    await withPublicDataCache({ stamp: "1", namespace: date, request, waitUntil: job => jobs.push(job) }, async () => Response.json(await loader({ request } as any)));
    await Promise.all(jobs);
    const annual = [...stored].find(([key]) => key.includes(encodeURIComponent("meetings:1:2025")));
    expect(annual?.[1]).toBe(String(expectedTTL));
  } finally { vi.useRealTimers(); vi.unstubAllGlobals(); }
});
