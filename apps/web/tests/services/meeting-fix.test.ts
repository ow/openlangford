import { describe, expect, it } from "vitest";
import { dropHighlight, editHighlight, quoteInRecords } from "../../app/services/meeting-fix.server";

const highlights = {
  bullets: ["Made final the zoning change for 3405 Happy Valley Road.", "Agreed to consider rezoning 902 Walfred Road and 960 Jenkins Avenue."],
  links: [[{ text: "3405 Happy Valley Road", agenda_item_id: 4549 }], [{ text: "902 Walfred Road", agenda_item_id: 4543 }, { text: "960 Jenkins Avenue", agenda_item_id: 4544 }]],
  description: "March 18, 2024: Council made one zoning change final.", version: "3",
};

describe("editing a meeting's highlights", () => {
  it("rewrites one bullet and keeps the links whose phrase the new text still carries, in order", () => {
    const out = editHighlight(highlights, 1, "Agreed to consider the first three readings for 960 Jenkins Avenue and 902 Walfred Road, with notice first for Jenkins.");
    expect(out.bullets[0]).toBe(highlights.bullets[0]);
    expect(out.bullets[1]).toContain("first three readings");
    // Both phrases are still there, so both links stay, in the new text's reading order (Jenkins now first).
    expect(out.links![1]).toEqual([{ text: "960 Jenkins Avenue", agenda_item_id: 4544 }, { text: "902 Walfred Road", agenda_item_id: 4543 }]);
    const fewer = editHighlight(highlights, 1, "Agreed to consider rezoning 902 Walfred Road.");
    expect(fewer.links![1]).toEqual([{ text: "902 Walfred Road", agenda_item_id: 4543 }]);
    expect(out.description).toBe(highlights.description);
    expect(highlights.bullets[1]).toContain("Agreed to consider rezoning");  // untouched
  });
  it("drops a bullet with its links", () => {
    const out = dropHighlight(highlights, 0);
    expect(out.bullets).toEqual([highlights.bullets[1]]);
    expect(out.links!).toEqual([highlights.links[1]]);
  });
});

describe("quoteInRecords", () => {
  const records = "MOTION: That Council proceed with consideration of First, Second and Third Readings of Bylaw No. 2162. | RESULT: Carried";
  it("finds a quote whatever its spacing and quote marks, and rejects a short or absent one", () => {
    expect(quoteInRecords("proceed with consideration of First,  Second and Third Readings", records)).toBe(true);
    expect(quoteInRecords("Council gave first reading", records)).toBe(false);
    expect(quoteInRecords("Carried", records)).toBe(false);
    expect(quoteInRecords(null, records)).toBe(false);
  });
});
