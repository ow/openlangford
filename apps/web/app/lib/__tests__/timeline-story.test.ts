import { describe, expect, it } from "vitest";
import { collapseListedReadings, projectNumbers, readingStage, sameProject, showsInTimeline } from "../timeline-story";

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
