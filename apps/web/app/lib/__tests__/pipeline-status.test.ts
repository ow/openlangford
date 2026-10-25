import { describe, expect, it } from "vitest";
import {
  SOURCE_STATE_LABELS,
  rawStatusLabel,
  sourceMeetingState,
  todayKey,
} from "../pipeline-status";

const today = "2026-10-25";
const m = (status: string, meeting_date: string, latest_job?: any) => ({
  status,
  meeting_date,
  latest_job,
});

describe("sourceMeetingState", () => {
  it("treats ingested and legacy extracted as done, whatever the date", () => {
    expect(sourceMeetingState(m("ingested", "2024-01-01"), today)).toBe("done");
    expect(sourceMeetingState(m("extracted", "2024-01-01"), today)).toBe("done");
  });

  it("keeps cancelled and postponed regardless of date or job failures", () => {
    expect(sourceMeetingState(m("cancelled", "2026-08-17", { status: "failed" }), today)).toBe("cancelled");
    expect(sourceMeetingState(m("postponed", "2026-12-01"), today)).toBe("postponed");
  });

  it("calls future meetings upcoming", () => {
    expect(sourceMeetingState(m("scheduled", "2026-11-02"), today)).toBe("upcoming");
    expect(sourceMeetingState(m("discovered", "2026-10-25"), today)).toBe("upcoming");
  });

  it("calls a recent past meeting without output waiting for minutes", () => {
    expect(sourceMeetingState(m("discovered", "2026-10-20"), today)).toBe("waiting");
    expect(sourceMeetingState(m("documents_downloaded", "2026-10-01"), today)).toBe("waiting");
  });

  it("flags failed jobs and long-stuck meetings", () => {
    expect(sourceMeetingState(m("discovered", "2026-10-20", { status: "failed" }), today)).toBe("attention");
    expect(sourceMeetingState(m("discovered", "2026-05-01"), today)).toBe("attention");
  });

  it("does not flag a failed job on a done meeting", () => {
    expect(sourceMeetingState(m("ingested", "2026-10-20", { status: "failed" }), today)).toBe("done");
  });
});

describe("labels", () => {
  it("has plain-language labels", () => {
    expect(SOURCE_STATE_LABELS.waiting).toBe("Waiting for minutes");
    expect(SOURCE_STATE_LABELS.attention).toBe("Needs attention");
  });
  it("formats raw statuses for tooltips", () => {
    expect(rawStatusLabel("documents_downloaded")).toBe("documents downloaded");
  });
  it("formats today in YYYY-MM-DD in Vancouver time", () => {
    expect(todayKey(new Date("2026-10-26T03:00:00Z"))).toBe("2026-10-25");
  });
});
