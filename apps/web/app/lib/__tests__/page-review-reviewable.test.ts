import { describe, expect, it } from "vitest";
import { isReviewable } from "../page-review-types";

describe("isReviewable", () => {
  it("covers single topic, meeting, property, participant and election pages", () => {
    for (const p of ["/matters/x", "/meetings/2024-01-08-council", "/properties/123", "/participants/a", "/elections/2022"]) expect(isReviewable(p)).toBe(true);
  });
  it("leaves out documents, lists, other pages, bylaws, councillors and admin", () => {
    for (const p of ["/", "/updates", "/about", "/matters", "/meetings", "/meetings/closed", "/meetings/x/documents/5",
      "/bylaws/300", "/people/someone", "/admin/reviews"]) expect(isReviewable(p)).toBe(false);
  });
});
