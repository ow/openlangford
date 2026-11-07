import { describe, expect, it } from "vitest";
import { splitTerms } from "../../app/lib/glossary";

describe("splitTerms", () => {
  it("marks the first occurrence of each hinted term and leaves the rest plain", () => {
    const segs = splitTerms("Gave first, second and third readings to the bylaw; the motion carried. Later carried again.");
    const marked = segs.filter((s) => s.term).map((s) => [s.text, s.term!.id]);
    expect(marked).toEqual([["first, second and third readings", "readings"], ["carried", "carried"]]);
    expect(segs.map((s) => s.text).join("")).toBe("Gave first, second and third readings to the bylaw; the motion carried. Later carried again.");
  });
  it("skips terms the page has shown already", () => {
    const segs = splitTerms("Bylaw adopted; motion carried.", new Set(["adoption"]));
    expect(segs.filter((s) => s.term).map((s) => s.term!.id)).toEqual(["carried"]);
  });
  it("matches whole words only", () => {
    expect(splitTerms("The table was set and the reading lamp lit.").some((s) => s.term?.id === "tabled")).toBe(false);
    expect(splitTerms("Item tabled to May 9.").some((s) => s.term?.id === "tabled")).toBe(true);
  });
});
