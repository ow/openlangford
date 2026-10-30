import { expect, it } from "vitest";
import { displaySummary, highlightPoints, linkSegments, meetingHighlights } from "../../app/lib/meeting-summary";
import { summaryPoints } from "../../app/components/meeting/MeetingSummary";

it("shows the plain-language highlights when a meeting has them, else its summary", () => {
  const highlights = { bullets: ["Council passed new garbage rules.", " ", "Council approved 47 homes on Latoria Road."], description: "x", version: "1" };
  expect(meetingHighlights({ highlights })).toEqual(["Council passed new garbage rules.", "Council approved 47 homes on Latoria Road."]);
  expect(summaryPoints(displaySummary({ summary: "- Adopted Bylaw 2299.", meta: { highlights } })!)).toEqual([
    "Council passed new garbage rules.", "Council approved 47 homes on Latoria Road.",
  ]);
  expect(displaySummary({ summary: "- Adopted Bylaw 2299.", highlights: null })).toBe("- Adopted Bylaw 2299.");
  expect(displaySummary({ summary: null, highlights: { bullets: [] } })).toBeNull();
});

it("keeps valid highlight links aligned with their bullets and drops invalid ones", () => {
  const highlights = {
    bullets: ["Asked staff to bring 2609 Sooke Road and Jacklin Road back.", " ", "Capped garbage fees."],
    links: [
      [
        { text: "2609 Sooke Road", agenda_item_id: 1 },
        { text: "Jacklin Road", agenda_item_id: 2 },
        { text: "Sooke Road", agenda_item_id: 3 }, // before the previous link: dropped
        { text: "Strathmore Road", agenda_item_id: 4 }, // not in the bullet
      ],
      [],
      [{ text: "garbage fees", agenda_item_id: "x" }], // bad id
    ],
    version: "2",
  };
  const points = highlightPoints({ highlights })!;
  expect(points.map((p) => p.links)).toEqual([
    [{ text: "2609 Sooke Road", agenda_item_id: 1 }, { text: "Jacklin Road", agenda_item_id: 2 }],
    [],
  ]);
  expect(linkSegments(points[0])).toEqual([
    { text: "Asked staff to bring " },
    { text: "2609 Sooke Road", itemId: 1 },
    { text: " and " },
    { text: "Jacklin Road", itemId: 2 },
    { text: " back." },
  ]);
  // Version 1 highlights have no links.
  expect(highlightPoints({ highlights: { bullets: ["Passed."] } })).toEqual([{ text: "Passed.", links: [] }]);
});
