import { describe, expect, it } from "vitest";
import { dropHighlight, editHighlight, findSegment, moveItemStart, quoteInRecords, timedTranscript } from "../../app/services/meeting-fix.server";

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
    // Two passages quoted together count when each is in the record; not when one isn't.
    expect(quoteInRecords("“That Council proceed with consideration of First” “Third Readings of Bylaw No. 2162. | RESULT: Carried”", records)).toBe(true);
    expect(quoteInRecords("“That Council proceed with consideration” … “Fourth Reading of Bylaw No. 2162”", records)).toBe(false);
    // Model-written lines are not the record.
    const withNotes = `${records}\n  NOTES (model-extracted from report "Staff report"): the project adds 12 townhouses on the site\nFOUND for [item-1] (the fix agent searched the City's records): supported. Council approved twelve townhouses.`;
    expect(quoteInRecords("the project adds 12 townhouses on the site", withNotes)).toBe(false);
    expect(quoteInRecords("Council approved twelve townhouses", withNotes)).toBe(false);
  });
});

describe("moving an item's start to a transcript moment", () => {
  const segments = [
    { start_time: 3866, speaker_name: "Chair", text_content: "Thank you. Just wanted to be absolutely clear." },
    { start_time: 3876, speaker_name: "Keith Yacucha", text_content: "Yeah, I'd be happy to entertain a motion at this time. Okay. I'll move that council adopt the solid waste collection bylaw." },
    { start_time: 5251, speaker_name: "Mary Wagner", text_content: "Pardon me. I'll move option one that council adopt Langford zoning bylaw number 300." },
  ];
  const items = [
    { id: 6738, discussion_start_time: 3690, discussion_end_time: 3714 },
    { id: 6739, discussion_start_time: 3714, discussion_end_time: 4483 },
    { id: 6740, discussion_start_time: 4483, discussion_end_time: 5252 },
    { id: 6741, discussion_start_time: 5252, discussion_end_time: 5496 },
  ];
  it("finds the segment the agent quoted, whatever its spacing, and nothing for a short or invented quote", () => {
    expect(findSegment(segments, "I'll move that council adopt the  solid waste collection bylaw", 4483)?.start_time).toBe(3876);
    expect(findSegment(segments, "I'll move", 4483)).toBeNull();
    expect(findSegment(segments, "I'll move that council adopt the parks bylaw as presented", 4483)).toBeNull();
  });
  it("starts the item at that moment and ends the item before it there", () => {
    expect(moveItemStart(items, 6740, 3876)).toEqual([{ id: 6740, discussion_start_time: 3876 }, { id: 6739, discussion_end_time: 3876 }]);
  });
  it("refuses a start that is after the item's end or before the meeting's first item", () => {
    expect(moveItemStart(items, 6740, 5300)).toBeNull();
    expect(moveItemStart(items, 6740, 3600)).toBeNull();
  });
  it("moving a start back past earlier items clears their windows for the alignment stage to fill again", () => {
    // 6739 and 6740 were placed too late (the real 6741 began before them); 6738 ends where 6741 now starts.
    expect(moveItemStart(items, 6741, 3700)).toEqual([
      { id: 6741, discussion_start_time: 3700 }, { id: 6738, discussion_end_time: 3700 },
      { id: 6739, discussion_start_time: null, discussion_end_time: null }, { id: 6740, discussion_start_time: null, discussion_end_time: null },
    ]);
  });
  it("writes the transcript with clock times, within the window", () => {
    const text = timedTranscript(segments, 3800, 4000);
    expect(text).toContain("[1:04:36] Keith Yacucha: Yeah, I'd be happy");
    expect(text).not.toContain("Mary Wagner");
  });
});
