import { describe, expect, it } from "vitest";
import { addressPatterns, spokenAtItem } from "../../app/services/property-search.server";

describe("addressPatterns", () => {
  it("matches the address as the records write it: full type, abbreviation, hyphen or space, or no type", () => {
    const p = addressPatterns("3680", "Trans-Canada Highway");
    expect(p).toContain("%3680 Trans%Canada%highway%");
    expect(p).toContain("%3680 Trans%Canada%hwy%");
    expect(p).toContain("%3680 Trans%Canada%");
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
