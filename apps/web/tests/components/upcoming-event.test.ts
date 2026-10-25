import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { CalendarProvenance } from "../../app/components/calendar-provenance";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { IncomingCouncilSection } from "../../app/components/home/incoming-council-section";
import { MeetingCard } from "../../app/components/meeting-card";
import { HeroDecisions } from "../../app/components/home/hero-decisions";

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-20T16:00:00Z")); });
afterEach(() => vi.useRealTimers());

it("lists inauguration as the next event without implying a regular council meeting", () => {
  const html = renderToStaticMarkup(h(MemoryRouter, null,
    h(HeroDecisions, { shortName: "Langford", decisions: [], upcoming: [
      { id: 1, title: "Inauguration", meeting_date: "2026-11-02" },
      { id: 2, title: "Regular Council", meeting_date: "2026-11-23" },
    ] }),
  ));
  expect(html).toContain("Coming up");
  expect(html).toContain("Inauguration");
  expect(html).toMatch(/Next · Monday/);
  expect(html).not.toContain("Next meeting");
});

it("leads with the decision headline and falls back to the summary", () => {
  const decision = {
    id: 1, summary: "Adopted development charges to help pay for future parks and parkland.",
    result: "CARRIED", meetingId: 9, meetingDate: "2026-10-05", meetingTitle: "Regular Council",
    yesCount: 5, noCount: 0, voteCoverage: "reconstructed_complete", isDivided: false,
  };
  const render = (d: typeof decision & { headline?: string | null }) =>
    renderToStaticMarkup(h(MemoryRouter, null, h(HeroDecisions, { shortName: "Langford", decisions: [d], upcoming: [] })));
  const withHeadline = render({ ...decision, headline: "Developers to pay toward future parks" });
  expect(withHeadline).toContain("Developers to pay toward future parks");
  expect(withHeadline).not.toContain("Adopted development charges");
  expect(withHeadline).toContain("Passed 5–0");
  expect(render({ ...decision, headline: null })).toContain("Adopted development charges");
});


it("calls the November 2 incoming-council event Inauguration", () => {
  const html = renderToStaticMarkup(h(MemoryRouter, null,
    h(IncomingCouncilSection, { council: {
      termId: 2, startDate: "2026-11-02", preliminary: false, members: [],
    } }),
  ));
  expect(html).toContain("Inauguration is scheduled for November 2, 2026.");
  expect(html).not.toMatch(/inaugural meeting|first council meeting/i);
});

const calendarEvent = {
  id: 1, title: "Inauguration", type: "Inauguration", calendar_source_id: 7,
  meeting_date: "2026-11-02", agendaPreview: [], meta: { calendar: {
    source_url: "https://langford.ca/meetings/", verified_at: "2026-10-20T16:00:00Z", start_time: null,
  } },
};

it.each([MeetingCard])("keeps concise schedule metadata inside the card with separate accessible source and event links", Component => {
  const html = renderToStaticMarkup(h(MemoryRouter, null,
    h(Component as any, { meeting: calendarEvent }),
  ));
  expect(html).toMatch(/<article\b[\s\S]*Time and agenda not yet published[\s\S]*<\/article>/);
  expect(html).toMatch(/<a[^>]*href="https:\/\/langford.ca\/meetings\/"[^>]*aria-label="Scheduled — official source[^"]*"[^>]*>Scheduled<\/a>/);
  expect(html).not.toContain("Schedule checked");
  expect(html).not.toContain(">Official source<");
  expect(html).not.toContain("Agenda not yet available");
  expect(html).not.toMatch(/<a\b[^>]*>(?:(?!<\/a>)[\s\S])*<a\b/);
});

it.each([
  [null, true, "Time not yet published"],
  ["19:00", false, "Agenda not yet published"],
  ["19:00", true, "19:00 (Langford time)"],
])("only names missing details for time %s and agenda %s", (start_time, has_agenda, label) => {
  const html = renderToStaticMarkup(h(CalendarProvenance, {compact:true, meeting: {
    ...calendarEvent, has_agenda, meta: { calendar: {...calendarEvent.meta.calendar, start_time} },
  }}));
  expect(html).toContain(label);
  expect(html).not.toContain("Time and agenda not yet published");
  if (start_time) expect(html).not.toContain("Time not yet published");
  if (has_agenda) expect(html).not.toContain("Agenda not yet published");
});


it.each([
  ["Planned", "Scheduled date passed; occurrence unconfirmed"],
  ["Cancelled", "Cancelled"],
])("keeps past calendar-only %s events truthful and visibly stale", (status, label) => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-04T16:00:00Z"));
  try {
    const html = renderToStaticMarkup(h(CalendarProvenance, {meeting: {
      calendar_source_id:7, meeting_date:"2026-11-02",status,
      meta:{calendar:{source_url:"https://langford.ca/meetings/",verified_at:"2026-10-20T16:00:00Z",start_time:null}},
    }}));
    expect(html).toContain(label);
    expect(html).toContain("Schedule checked October 20, 2026");
    expect(html).toContain("Schedule check overdue");
    expect(html).not.toMatch(/Completed|Processing/);
  } finally { vi.useRealTimers(); }
});
