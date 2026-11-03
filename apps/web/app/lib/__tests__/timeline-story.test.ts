import { describe, expect, it } from "vitest";
import { collapseListedReadings, foldSameMeetingSteps, projectNumbers, readingStage, sameProject, showsInTimeline } from "../timeline-story";

describe("projectNumbers", () => {
  it("reads bylaw and application numbers, never city-wide bylaws", () => {
    expect([...projectNumbers("Bylaw No. 1314; File No. Z-10-12")].sort()).toEqual(["Z10-12", "bylaw 1314"].sort());
    expect([...projectNumbers("DVP-10-15; Zoning Bylaw No. 300; Sign Bylaw No. 1250")]).toEqual(["DVP10-15"]);
    expect([...projectNumbers("Bylaw Nos. 1332, 1349 and 1378")].sort()).toEqual(["bylaw 1332", "bylaw 1349", "bylaw 1378"]);
  });
});

describe("showsInTimeline", () => {
  it("borrows a related topic's entries only for the same project or a confirmed link", () => {
    // 2945 Jacklin Road: the 2017 showroom permit and the 2010 cinema variances share only an address.
    expect(showsInTimeline({ source: "name" }, ["TUP17-0003"], { identifier: "DVP-10-15" })).toBe(false);
    expect(showsInTimeline({ source: "name" }, ["Bylaw No. 1314"], { identifier: "Bylaw No. 1314; File No. 3900-1314" })).toBe(true);
    expect(showsInTimeline({ source: "reviewed_official_history" }, [null], { identifier: null })).toBe(true);
    expect(showsInTimeline({ source: "name", review: "accepted" }, [null], { identifier: null })).toBe(true);
    expect(sameProject(["Bylaw No. 300"], "Zoning Bylaw No. 300")).toBe(false);
  });
});

describe("collapseListedReadings", () => {
  const entry = (id: number, meeting: number, title: string) => ({ kind: "primary", item: { id, meeting_id: meeting, title, motions: [] } });
  it("drops a 'listed for first reading' line next to the first reading given at the same meeting", () => {
    const entries = [entry(2312, 9, 'BYLAW NO. 1788 (FIRST READING)'), entry(2297, 9, "Application to amend CD6A - Bylaw No. 1788"),
      entry(788, 8, "PUBLIC HEARING - BYLAW NO. 1788"), entry(811, 8, "BYLAW NO. 1788 (SECOND AND THIRD READINGS)")];
    const headlines = { "2312": "Density allocation amendment listed for first reading", "2297": "First reading given to CD6A density allocation amendment",
      "788": "Public hearing held on density allocation", "811": "Second and third readings listed after public hearing" };
    expect(collapseListedReadings(entries, headlines).map((e) => e.item.id)).toEqual([2297, 788, 811]);
  });
  it("keeps entries at different meetings or stages", () => {
    const entries = [entry(1, 1, "BYLAW NO. 5 (FIRST READING)"), entry(2, 2, "BYLAW NO. 5 (FIRST READING)")];
    expect(collapseListedReadings(entries, { "1": "Bylaw listed for first reading", "2": "First reading given" })).toHaveLength(2);
    expect(readingStage("Second and third readings given")).toBe("2-3");
    expect(readingStage("Public hearing held")).toBeNull();
  });
});

describe("foldSameMeetingSteps", () => {
  const entry = (id: number, meeting: number, title: string, motions: string[] = [], meta: any = {}) =>
    ({ kind: "primary", item: { id, meeting_id: meeting, title, meta, motions: motions.map((text_content) => ({ text_content })) } });
  it("folds a staff report with no decision into the reading it recommended at the same meeting", () => {
    // 760 Latoria Road, Apr 2014: the application report and Bylaw 1518's first reading.
    const entries = [entry(12255, 844, "Application to Rezone the property at 760 Latoria Road"),
      entry(12277, 844, "BYLAW NO. 1518 (FIRST READING)", ["That Council give Bylaw No. 1518 First Reading."])];
    const out = foldSameMeetingSteps(entries);
    expect(out.map((e) => e.item.id)).toEqual([12277]);
    expect((out[0] as any).folded.map((i: any) => i.id)).toEqual([12255]);
  });
  it("folds the same readings given twice, keeping the fuller motion", () => {
    // The 2016 financial plan: the report's motion gives three readings and keeps class multiples; the bylaw item repeats the readings.
    const entries = [entry(6003, 353, "REPORT - 2016-2020 Five-Year Financial Plan", ["1. Give Financial Plan Bylaw No. 1628, 2016 three readings; 2. That there be no change to the class multiples"]),
      entry(6012, 353, "BYLAW NO. 1628 (FIRST, SECOND AND THIRD READING)", ["That Council give Bylaw No. 1628 First, Second and Third Reading."])];
    expect(foldSameMeetingSteps(entries).map((e) => e.item.id)).toEqual([6003]);
  });
  it("keeps hearings, items with speakers, other meetings and other bylaws apart", () => {
    const hearing = [entry(1, 5, "PUBLIC HEARING - BYLAW NO. 9"), entry(2, 5, "BYLAW NO. 9 (THIRD READING)", ["Third reading of Bylaw No. 9"])];
    expect(foldSameMeetingSteps(hearing)).toHaveLength(2);
    const speakers = [entry(3, 6, "Report - rezoning", [], { participation: { speakers: [{ name: "A resident" }] } }), entry(4, 6, "BYLAW NO. 9", ["First reading of Bylaw No. 9"])];
    expect(foldSameMeetingSteps(speakers)).toHaveLength(2);
    const apart = [entry(5, 7, "Report - rezoning"), entry(6, 8, "BYLAW NO. 9", ["First reading of Bylaw No. 9"]),
      entry(7, 9, "BYLAW NO. 1510", ["First reading of Bylaw No. 1510"]), entry(8, 9, "BYLAW NO. 1511", ["First reading of Bylaw No. 1511"])];
    expect(foldSameMeetingSteps(apart)).toHaveLength(4);
  });
});
