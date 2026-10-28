import { describe, expect, it } from "vitest";
import { buildStrip, classifyAppearance, motionOutcome, spanLabel, type StripEntry } from "../../app/lib/matter-timeline";

const primary = (key: string, date: string, motions: any[] = [], extra: Partial<StripEntry> = {}): StripEntry => ({
  key, date, meetingId: Number(date.replace(/-/g, "")), kind: "primary", title: "Rezoning", motions, ...extra,
});

describe("matter appearance outcomes", () => {
  it("classifies motions by result, treating deferrals as deferred even when carried", () => {
    expect(motionOutcome({ result: "CARRIED", text_content: "THAT Council give first reading" })).toBe("passed");
    expect(motionOutcome({ result: "CARRIED", text_content: "THAT the application be referred back to staff" })).toBe("deferred");
    expect(motionOutcome({ result: "DEFEATED" })).toBe("defeated");
    expect(motionOutcome({ result: "TABLED" })).toBe("deferred");
    expect(motionOutcome({ result: "CARRIED", disposition: "Referred" })).toBe("deferred");
    expect(motionOutcome({ result: null })).toBeNull();
    expect(motionOutcome({ result: "CARRIED", disposition: "Amended", text_content: "Amendment: THAT the main motion be amended" })).toBeNull();
  });

  it("ignores amendments and uses the headline when the main motion has no recorded result", () => {
    const motions = [{ result: null, text_content: "THAT Council take no action until the variances are removed" }, { result: "CARRIED", disposition: "Amended", text_content: "Amendment: ..." }];
    expect(classifyAppearance([primary("a", "2026-09-08", motions, { headline: "Action deferred pending variance changes" })])).toBe("deferred");
    expect(classifyAppearance([primary("a", "2026-09-08", motions)])).toBe("discussed");
  });

  it("picks the most decisive outcome for a meeting and falls back to comment or discussion", () => {
    expect(classifyAppearance([primary("a", "2026-01-01", [{ result: "DEFEATED" }, { result: "CARRIED" }])])).toBe("passed");
    expect(classifyAppearance([primary("a", "2026-01-01", [{ result: "DEFEATED" }])])).toBe("defeated");
    expect(classifyAppearance([{ key: "m", date: "2026-01-01", kind: "mention", title: "Public Participation" }])).toBe("comment");
    expect(classifyAppearance([primary("a", "2026-01-01", [], { hasSpeakers: true })])).toBe("comment");
    expect(classifyAppearance([{ key: "e", date: "2026-01-01", kind: "evidence", title: "Correspondence re: rezoning" }])).toBe("discussed");
    expect(classifyAppearance([primary("a", "2026-01-01")])).toBe("discussed");
  });
});

describe("matter time strip", () => {
  it("places one mark per meeting on a linear date scale", () => {
    const strip = buildStrip(
      [primary("c", "2026-10-29", [{ result: "CARRIED" }]), primary("b", "2026-10-08"), primary("a", "2026-10-01"), { ...primary("a2", "2026-10-01"), kind: "mention" }],
      { today: "2026-11-30" },
    )!;
    expect(strip.marks.map((m) => [m.date, Math.round(m.x)])).toEqual([["2026-10-01", 0], ["2026-10-08", 25], ["2026-10-29", 100]]);
    expect(strip.marks[0]).toMatchObject({ anchor: "a", count: 2 });
    expect(strip.label).toBe("Oct 2026 · 4 weeks");
    expect(strip.ticks).toEqual([]);
  });

  it("extends an ongoing matter to today", () => {
    const strip = buildStrip([primary("a", "2026-09-01"), primary("b", "2026-09-29")], { today: "2026-10-27", ongoing: true })!;
    expect(strip.end).toBe("2026-10-27");
    expect(Math.round(strip.marks[1].x)).toBe(50);
    expect(strip.label).toBe("Sep 2026 – today · 8 weeks");
  });

  it("centres a single appearance", () => {
    const strip = buildStrip([primary("a", "2026-09-14")], { today: "2026-10-27" })!;
    expect(strip.marks).toHaveLength(1);
    expect(strip.marks[0].x).toBe(50);
    expect(strip.label).toBe("Sep 2026 · 1 meeting");
  });

  it("adds year ticks for long spans, thinning them over a decade", () => {
    const strip = buildStrip([primary("a", "2019-03-01"), primary("b", "2023-06-01")], { today: "2026-10-27" })!;
    expect(strip.ticks.map((t) => t.label)).toEqual(["2020", "2021", "2022", "2023"]);
    expect(strip.label).toBe("Mar 2019 – Jun 2023 · 4.5 years");
    const long = buildStrip([primary("a", "2009-03-01"), primary("b", "2025-06-01")], { today: "2026-10-27" })!;
    expect(long.ticks.map((t) => t.label)).toEqual(["2010", "2015", "2020", "2025"]);
    expect(buildStrip([], { today: "2026-10-27" })).toBeNull();
  });

  it("labels spans in sensible units", () => {
    expect(spanLabel("2026-01-01", "2026-01-04")).toBe("3 days");
    expect(spanLabel("2026-01-01", "2026-06-01")).toBe("5 months");
    expect(spanLabel("2024-01-01", "2025-07-01")).toBe("18 months");
    expect(spanLabel("2020-01-01", "2022-07-01")).toBe("2.5 years");
  });
});
