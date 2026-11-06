import { describe, expect, it } from "vitest";
import { shapeListMeeting } from "../../app/lib/meeting-list";
import { highlightPoints } from "../../app/lib/meeting-summary";

const base = { id: 1, summary: "A long original summary.\n- point" };

describe("shapeListMeeting", () => {
  it("leaves meetings without highlights alone", () => {
    expect(shapeListMeeting({ ...base, highlights: null })).toEqual({ ...base, highlights: null });
  });
  it("keeps only the three rendered points, with their links", () => {
    const highlights = {
      version: 2,
      model: "x",
      bullets: ["one two", "three four", "five six", "seven eight"],
      links: [[{ text: "two", agenda_item_id: 9 }], [], [{ text: "six", agenda_item_id: 4 }], []],
    };
    const shaped = shapeListMeeting({ ...base, highlights });
    expect(shaped.highlights.bullets).toEqual(["one two", "three four", "five six"]);
    expect(Object.keys(shaped.highlights).sort()).toEqual(["bullets", "links"]);
    expect(highlightPoints(shaped)).toEqual(highlightPoints({ highlights })!.slice(0, 3));
  });
  it("keeps summary truthy but short, and absent summaries absent", () => {
    const highlights = { bullets: ["first", "second"], links: [] };
    expect(shapeListMeeting({ summary: "long", highlights }).summary).toBe("first");
    expect(shapeListMeeting({ summary: null, highlights }).summary).toBeNull();
  });
});
