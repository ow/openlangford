import { expect, it } from "vitest";
import { displaySummary, meetingHighlights } from "../../app/lib/meeting-summary";
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
