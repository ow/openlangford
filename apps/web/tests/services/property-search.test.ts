import { describe, expect, it } from "vitest";
import { addressPatterns, spokenAtItem } from "../../app/services/property-search.server";

describe("addressPatterns", () => {
  it("matches the address as the records write it: full type, abbreviation, hyphen or space, or no type", () => {
    const p = addressPatterns("3680", "Trans-Canada Highway");
    expect(p).toContain("%3680 Trans%Canada%highway%");
    expect(p).toContain("%3680 Trans%Canada%hwy%");
    expect(p).toContain("%3680 Trans%Canada%");
    expect(p).toContain("%3680 TCH%");
    expect(addressPatterns("3094", "Jacklin Road")).not.toContain("%3094 JR%");
  });
  it("keeps a street with no known type whole, and refuses an empty address", () => {
    expect(addressPatterns("12", "Westhills Stadium")).toEqual(["%12 Westhills%Stadium%"]);
    expect(addressPatterns("", "Jacklin Road")).toEqual([]);
    expect(addressPatterns("3094", "Road")).toEqual([]);
  });
});

describe("spokenAtItem", () => {
  const items = [
    { id: 1, meeting_id: 284, discussion_start_time: 185, discussion_end_time: 7359 }, // PRESENTATIONS, holding the next
    { id: 2, meeting_id: 284, discussion_start_time: 188, discussion_end_time: 7127 }, // Parks Master Plan
    { id: 3, meeting_id: 284, discussion_start_time: null, discussion_end_time: null },
    { id: 4, meeting_id: 23, discussion_start_time: 900, discussion_end_time: 1300 },
  ];
  it("picks the narrowest entry whose discussion window holds the line, at that meeting only", () => {
    expect(spokenAtItem({ meeting_id: 284, start_time: 1111 }, items)?.id).toBe(2);
    expect(spokenAtItem({ meeting_id: 284, start_time: 7200 }, items)?.id).toBe(1);
    expect(spokenAtItem({ meeting_id: 23, start_time: 1111 }, items)?.id).toBe(4);
  });
  it("gives up when nothing was on screen then, or the line has no time", () => {
    expect(spokenAtItem({ meeting_id: 284, start_time: 9000 }, items)).toBeNull();
    expect(spokenAtItem({ meeting_id: 999, start_time: 1111 }, items)).toBeNull();
    expect(spokenAtItem({ meeting_id: 284, start_time: null }, items)).toBeNull();
  });
});

describe("addressExcerpt", () => {
  it("windows on the address and scores money and sale words", async () => {
    const { addressExcerpt } = await import("../../app/services/property-timeline.server");
    const table = addressExcerpt("| PD02 - 3680 TCH | 825,000 |\n| PD03 - JLBP Clubhouse | 3,000,000 |", "3680");
    expect(table.text.startsWith("PD02 - 3680 TCH 825,000")).toBe(true);
    expect(table.score).toBeGreaterThan(0);
    const long = addressExcerpt("x".repeat(400) + " 3680 Trans Canada Highway: explore the sale of the parcel " + "y".repeat(400), "3680");
    expect(long.text.startsWith("…") && long.text.endsWith("…") && long.text.includes("explore the sale")).toBe(true);
    expect(addressExcerpt("Facilities include 3680 Trans Canada Highway property and the bike park.", "3680").score).toBe(0);
  });
});

describe("property timeline grouping", () => {
  it("folds rows from one meeting into a card when something was decided, and spots tables", async () => {
    const { groupEntries, looksTabular } = await import("../../app/components/property/property-timeline");
    const meeting = { id: 7, title: "Special Council", href: "/meetings/x", committee: false };
    const groups = groupEntries([
      { key: "step-1", date: "2019-08-19", kind: "step", label: "", headline: "Permit issued", meeting, outcome: { label: "Passed", variant: "success" } },
      { key: "item-2", date: "2019-08-19", kind: "mention", label: "", headline: "Public Participation", meeting },
      { key: "closed-7", date: "2019-08-19", kind: "closed", label: "Closed meeting", headline: "Closed doors", meeting },
      { key: "source-3", date: "2019-11-02", kind: "source", label: "Reported by Victoria News", headline: "City buys land" },
    ]);
    expect(groups.map((g) => g.key)).toEqual(["source-3", "meeting-7"]);
    expect(groups[1].decided).toBe(true);
    expect(groups[1].entries.map((e) => e.key)).toEqual(["step-1", "item-2", "closed-7"]);
    expect(looksTabular("DAJ000005776 5/7/2019 DAJ Young Anderson 3680 TCH Yes CMTRX00003073 $1,272,578.89 DAJ000005778 5/9/2019 DAJ Shell PAP Apr 14 Yes CMTRX00003074 $865.23")).toBe(true);
    expect(looksTabular("The City recently acquired the property at 3680 Trans-Canada Hwy, one of the few oceanfront properties within the City of Langford. The property is currently zoned RR4.")).toBe(false);
  });
});
