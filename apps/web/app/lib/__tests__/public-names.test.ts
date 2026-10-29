import { describe, it, expect } from "vitest";
import { applyNameDecision, suggestedSpellings } from "../public-names";

const participation = {
  overview: "x",
  speakers: [
    { who: "A resident (Glen Willow Place)", name_ref: "marie watmo", point: "a" },
    { who: "Holly Adams", name_ref: "holly adams", point: "b" },
    { who: "A resident", point: "c" },
  ],
};

describe("applyNameDecision", () => {
  it("names only the referenced speaker and keeps the street", () => {
    const { participation: next, changed } = applyNameDecision(participation, "marie watmo", "Marie Watmough");
    expect(changed).toBe(true);
    expect(next?.speakers?.map((s) => s.who)).toEqual(["Marie Watmough (Glen Willow Place)", "Holly Adams", "A resident"]);
  });

  it("can take a name back to anonymous", () => {
    const { participation: next } = applyNameDecision(participation, "holly adams", null);
    expect(next?.speakers?.[1].who).toBe("A resident");
  });

  it("drops a profile link when the shown name changes", () => {
    const linked = { speakers: [{ who: "Holly Adams", name_ref: "holly adams", person_id: 7 }] };
    const { participation: next } = applyNameDecision(linked, "holly adams", null);
    expect(next?.speakers?.[0]).toEqual({ who: "A resident", name_ref: "holly adams" });
  });

  it("reports no change when nothing matches", () => {
    expect(applyNameDecision(participation, "nobody", "X").changed).toBe(false);
    expect(applyNameDecision(null, "x", "y").changed).toBe(false);
  });
});

describe("suggestedSpellings", () => {
  it("offers the transcription and minutes spellings with the spoken first name", () => {
    expect(suggestedSpellings("Marie Watmo", [{ name: "M. Watmor" }, { name: "Marie Watmo" }, { name: "Mary Watmo" }])).toEqual([
      "Marie Watmo",
      "Marie Watmor",
      "Mary Watmo",
    ]);
  });
});
