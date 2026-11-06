import { describe, expect, it } from "vitest";
import { researchLine } from "../flag-research";

describe("researchLine", () => {
  it("renders a stored finding with its quote and ref", () => {
    const line = researchLine("Summary: x", { verdict: "contradicted", explanation: "The vote was 4-3.", quote: "carried 4-3", ref: "motion:9" });
    expect(line).toBe('RESEARCH on "Summary: x": contradicted. The vote was 4-3. The record says: “carried 4-3” (motion:9)');
  });
  it("leaves out a missing quote and says nothing without a finding", () => {
    expect(researchLine("a", { verdict: "not_found", explanation: "Nothing.", quote: null, ref: null })).toBe('RESEARCH on "a": not_found. Nothing.');
    expect(researchLine("a", null)).toBe("");
  });
});
