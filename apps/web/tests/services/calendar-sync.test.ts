import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { discoverCalendarEvents, syncCalendar, CALENDAR_URL } from "../../app/services/calendar-sync";
import schedule from "../../app/data/langford-schedule-2026.json";
// Retained official PDF bytes verify the reviewed fallback's hash, not a reimplementation of discovery.
const pdf = readFileSync(new URL("../fixtures/langford-2026-calendar.pdf", import.meta.url));
const event = { ID: "11111111-1111-4111-a111-111111111111", StartDate: "2026/11/23 19:00:00", MeetingType: "Council Meeting", MeetingName: "Council Meeting" };
let rows: unknown[];
let pdfBytes: Uint8Array;
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-20T16:00:00Z")); rows = []; pdfBytes = pdf;
  fetchMock = vi.fn(async (url: string) => url === CALENDAR_URL
    ? Response.json({ d: rows }) : new Response(pdfBytes as BodyInit));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it("imports the six reviewed future dates without manufacturing the inauguration time", async () => {
  const result = await discoverCalendarEvents();
  expect(result.warnings).toEqual([]);
  expect(result.events.map(e => [e.meeting_date,e.type,e.start_time])).toEqual([
    ["2026-11-02","Inauguration",null], ["2026-11-09","Advisory Committee","19:00"],
    ["2026-11-23","Regular Council","19:00"], ["2026-11-24","Advisory Committee","19:00"],
    ["2026-11-25","Advisory Committee","14:00"], ["2026-12-07","Regular Council","19:00"],
  ]);
  expect(result.events.every(e => e.source_url === schedule.sourceUrl)).toBe(true);
});
it("uses published GUID identity, rejects past/unknown rows and preserves explicit cancellation", async () => {
  rows = [event, event, {...event, ID:"22222222-2222-4222-a222-222222222222", StartDate:"2026/10/05 19:00:00"},
    {...event, ID:"33333333-3333-4333-a333-333333333333",MeetingType:"Unknown"}];
  rows[0] = {...event, MeetingName:"Council Meeting - Cancelled"};
  const result = await discoverCalendarEvents();
  expect(result.events.filter(e => e.meeting_date === "2026-11-23")).toEqual([expect.objectContaining({ source_id:event.ID,source_type:"escribe",cancelled:true })]);
  expect(result.events.some(e => e.meeting_date < "2026-10-20")).toBe(false);
  expect(result.warnings).toContain("Unsupported calendar event held for review");
});
it("treats an attached cancellation notice as a cancellation", async () => {
  rows = [{...event, MeetingDocumentLink:[{Title:"Meeting Cancellation Notice ", Type:"AdditionalDocuments"}]},
    {...event, ID:"44444444-4444-4444-a444-444444444444", StartDate:"2026/11/24 17:30:00", MeetingType:"Special Council Meeting", MeetingDocumentLink:[{Title:"Agenda"}]}];
  const result = await discoverCalendarEvents();
  expect(result.events.filter(e => e.source_type === "escribe").map(e => e.cancelled)).toEqual([true, false]);
});
it("holds a changed PDF instead of interpreting its dates or colours", async () => {
  pdfBytes = new TextEncoder().encode("changed official calendar"); rows = [event];
  const result = await discoverCalendarEvents();
  expect(result.events).toEqual([expect.objectContaining({source_id:event.ID})]);
  expect(result.warnings).toEqual(["Annual calendar changed: reviewed schedule fallback held pending review"]);
});
it("stops after bounded retries and never applies an empty replacement snapshot on source failure", async () => {
  fetchMock.mockImplementation(async () => new Response("Unavailable", {status:503}));
  const db = {rpc:vi.fn(async (name: string) => ({ data:name === "claim_calendar_sync" ? "run-token" : null,error:null }))};
  const promise = syncCalendar(db as any,"cron");
  const rejection = expect(promise).rejects.toThrow("HTTP 503");
  await vi.runAllTimersAsync(); await rejection;
  expect(fetchMock).toHaveBeenCalledTimes(3);
  expect(db.rpc.mock.calls.map(c=>c[0])).toEqual(["claim_calendar_sync","fail_calendar_sync"]);
});
it("does no network work when an earlier run holds the lease", async () => {
  const db = {rpc:vi.fn(async () => ({data:null,error:null}))};
  expect(await syncCalendar(db as any,"cron")).toEqual({skipped:"another calendar sync is active"});
  expect(fetchMock).not.toHaveBeenCalled();
});
