import { describe, expect, it } from "vitest";
import { staffActionLabel, staffActionPage } from "../staff-actions";

describe("staffActionLabel", () => {
  it("reads ratings, found entries and agent fixes", () => {
    expect(staffActionLabel("rate", { verdict: "agree" })).toBe("Agreed with a flag");
    expect(staffActionLabel("rate", { verdict: "disagree" })).toBe("Disagreed with a flag");
    expect(staffActionLabel("rate", { verdict: "none" })).toBe("Cleared a flag rating");
    expect(staffActionLabel("accept", { agree: "0" })).toBe("Rejected a found entry");
    expect(staffActionLabel("accept", {})).toBe("Accepted a found entry");
    expect(staffActionLabel("agent:remove_entry")).toBe("Agent: remove entry");
  });
  it("falls back to the action in words", () => {
    expect(staffActionLabel("needs_work")).toBe("Asked the agent to fix a page");
    expect(staffActionLabel("something_new")).toBe("Something new");
    expect(staffActionLabel(null)).toBe("Made a change");
  });
});

describe("staffActionPage", () => {
  it("links the page a review-bar request named, or the page itself, never an API or admin path", () => {
    expect(staffActionPage("/api/page-review", { path: "/matters/x" })).toBe("/matters/x");
    expect(staffActionPage("/matters/y")).toBe("/matters/y");
    expect(staffActionPage("/api/page-review")).toBeNull();
    expect(staffActionPage("/admin/reviews")).toBeNull();
    expect(staffActionPage("/api/page-review", { path: "//evil.example" })).toBeNull();
  });
});
