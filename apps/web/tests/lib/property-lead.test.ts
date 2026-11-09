import { describe, expect, it } from "vitest";
import { splitLead, withClosing } from "../../app/lib/property-lead";

describe("splitLead", () => {
  it("separates the computed closing line from the text an editor works on", () => {
    expect(splitLead("The City bought it in 2019.  Mentioned in council meetings 26 times since 2019.")).toEqual({
      body: "The City bought it in 2019.", closing: "Mentioned in council meetings 26 times since 2019." });
  });
  it("leaves a lead with no closing line whole, and copes with none at all", () => {
    expect(splitLead("Just a lead.")).toEqual({ body: "Just a lead.", closing: null });
    expect(splitLead(null)).toEqual({ body: "", closing: null });
  });
});

describe("withClosing", () => {
  it("puts the old closing line on a new text", () => {
    expect(withClosing("Old. Mentioned in council meetings 5 times since 2012.", "New.")).toBe("New. Mentioned in council meetings 5 times since 2012.");
  });
});
