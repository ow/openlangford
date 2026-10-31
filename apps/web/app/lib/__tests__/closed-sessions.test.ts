import { describe, expect, it } from "vitest";
import { aboutDuration, closedSessionSentence, summariseTerms, summariseYears, type ClosedRow, type ClosedSessionMeta } from "../closed-sessions";

const session = (labels: string[]) => ({ closed_at: null, reconvened_at: null, reasons: [], reason_labels: labels, source: "minutes" as const, position: "end" as const });
const meta = (closed: number | null, open: number | null, labels: string[][] = [["land"]]): ClosedSessionMeta => ({
  sessions: labels.map(session), called_at: "19:00", adjourned_at: null, est_closed_minutes: closed, open_minutes: open,
  method: closed == null ? "none" : "minutes", confidence: closed == null ? "none" : "high", version: "2",
});
const row = (meeting_date: string, closed: ClosedSessionMeta | null, id = 1): ClosedRow => ({ id, slug: null, title: "Council", meeting_date, closed });

describe("closedSessionSentence", () => {
  it("states the length and reasons in plain words", () => {
    expect(closedSessionSentence(meta(44, 100, [["land", "legal advice"]]))).toBe("Council met privately for about 45 minutes (land, legal advice)");
  });
  it("leaves out an unknown length rather than guessing", () => {
    expect(closedSessionSentence(meta(null, null, [["legal advice"]]))).toBe("Council met privately (legal advice)");
  });
  it("is null for a meeting with no closed session", () => {
    expect(closedSessionSentence({ ...meta(0, 90), sessions: [] })).toBeNull();
    expect(closedSessionSentence(null)).toBeNull();
  });
  it("rounds hours", () => {
    expect(aboutDuration(78)).toBe("about 1 hour 20 minutes");
    expect(aboutDuration(121)).toBe("about 2 hours");
    expect(aboutDuration(7)).toBe("about 7 minutes");
  });
});

describe("summariseTerms", () => {
  const terms = [
    { name: "Old", start_date: "2018-11-05", end_date: "2022-11-06" },
    { name: "Recent", start_date: "2022-11-07", end_date: "2026-11-01" },
    { name: "New", start_date: "2026-11-02", end_date: null },
  ];
  it("measures only terms whose closed sessions are mostly timed, and skips terms not yet started", () => {
    const rows = [
      row("2019-01-01", meta(null, null)), row("2019-02-01", meta(null, null)), row("2019-03-01", meta(0, 30, [])),
      row("2023-01-01", meta(60, 120)), row("2023-02-01", meta(0, 120, [])), row("2023-03-01", meta(30, 30, [["land"], ["legal advice"]])),
    ];
    const [old, recent, ...rest] = summariseTerms(rows, terms, "2026-10-30");
    expect(rest).toHaveLength(0);
    expect(old).toMatchObject({ sessions: 2, measurable: false, closedHours: null, closedShare: null });
    expect(recent).toMatchObject({ sessions: 3, timedSessions: 3, measurable: true, timedMeetings: 3 });
    expect(recent.closedHours).toBeCloseTo(1.5);
    expect(recent.closedShare).toBeCloseTo(90 / 360);
    expect(recent.topReasons[0]).toEqual({ label: "land", count: 2 });
  });
  it("gives no yearly rate for a council only weeks old", () => {
    const [, , fresh] = summariseTerms([], terms, "2026-11-30");
    expect(fresh).toMatchObject({ name: "New", sessions: 0, perYear: null });
  });
});

describe("summariseYears", () => {
  it("counts sessions per year", () => {
    expect(summariseYears([row("2024-01-01", meta(10, 10)), row("2024-05-01", meta(null, null)), row("2025-01-01", null)]))
      .toMatchObject([{ year: 2024, sessions: 2, measurable: false }, { year: 2025, sessions: 0 }]);
  });
});
