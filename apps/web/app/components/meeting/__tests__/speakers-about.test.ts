import { describe, expect, it } from "vitest";
import { speakersAbout } from "../participation-list";

const speakers = [
  { who: "A", position: "opposes", topic: "Parking minimums", point: "Parking for new buildings." },
  { who: "B", position: "concerned", topic: "Waste management", point: "Curbside collection costs." },
];

describe("speakersAbout", () => {
  it("shows only the speakers judged to be about the topic", () => {
    expect(speakersAbout({ speakers, about_matters: { "7": [1] } }, "Residential waste collection parking", [7]).map((s) => s.who)).toEqual(["B"]);
  });
  it("counts a judgement for a topic merged into this one", () => {
    expect(speakersAbout({ speakers, about_matters: { "3": [0] } }, "anything", [7, 3]).map((s) => s.who)).toEqual(["A"]);
  });
  it("falls back to shared words when not yet judged", () => {
    expect(speakersAbout({ speakers }, "Curbside waste collection", [7]).map((s) => s.who)).toEqual(["B"]);
  });
});
