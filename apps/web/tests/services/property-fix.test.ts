import { describe, expect, it } from "vitest";
import { propertyPlanPrompt, propertyRecords, withClosing } from "../../app/services/property-fix.server";

const property = { id: 771, slug: "3094-jacklin-road", address: "3094 Jacklin Road", civic_number: "3094", street: "Jacklin Road", meta: {} };

describe("withClosing", () => {
  it("keeps the pipeline's closing count line from the old lead", () => {
    const old = "A duplex was approved here in 2019. Mentioned in council meetings 5 times since 2012.";
    expect(withClosing(old, "A six-storey building with 76 rental apartments was approved for this lot in 2026.  "))
      .toBe("A six-storey building with 76 rental apartments was approved for this lot in 2026. Mentioned in council meetings 5 times since 2012.");
  });
  it("adds nothing when the old lead had no closing line, and doesn't double one the agent wrote", () => {
    expect(withClosing(null, "New text.")).toBe("New text.");
    expect(withClosing("Old. Mentioned in council meetings twice in 2012.", "New text. Mentioned in council meetings twice in 2012.")).toBe("New text. Mentioned in council meetings twice in 2012.");
  });
});

describe("the planner's records and prompt", () => {
  it("keys each entry the way the page does and lists the other addresses a topic covers", () => {
    const records = propertyRecords(property as any, null, [
      { id: 506, title: "Jacklin Road rezoning", status: "Adopted", first_seen: "2026-04-13", last_seen: "2026-08-17", plain_english_summary: "A six-storey building with 76 rental apartments.", meta: { status_line: "Rezoning made final Aug 17, 2026." }, addresses: ["3084 Jacklin Road", "3088 Jacklin Road"] },
    ], [{ id: 13217, title: "Application to Rezone 3084, 3088, 3094/3096 Jacklin Road", plain_english_summary: null, meeting_date: "2026-04-13", meeting_title: "Regular Council" }]);
    expect(records).toContain("TOPIC matter-506");
    expect(records).toContain("ITEM item-13217");
    expect(records).toContain("3084 Jacklin Road; 3088 Jacklin Road");
    expect(records).toContain("LEAD (the page's own text): (none yet)");
    const prompt = propertyPlanPrompt(property as any, [{ key: "matter-506", problem: "different_story", reason: "About another lot.", excerpt: "", verdict: "agree" } as any], null, records, [null], null);
    expect(prompt).toContain("matter-506 ·");
    expect(prompt).toContain("unlink_entry");
    expect(prompt).toContain("rewrite_lead");
  });
});
