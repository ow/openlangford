import { describe, expect, it } from "vitest";
import { isCommitteeItem, stageExplanation } from "../timeline-step";

describe("stageExplanation", () => {
  it("calls Council's adoption final", () => {
    expect(stageExplanation(["Council adopts park amenity sponsorship policy", "That Council adopt the policy."])).toBe("Final approval.");
    expect(stageExplanation(['BYLAW NO. 1813 "Housing Agreement" (ADOPTION)'])).toBe("Final approval.");
  });
  it("doesn't call a committee recommendation final", () => {
    expect(stageExplanation(["Committee recommends park sponsorship policy", "That the committee recommend that Council adopt the policy."], { committee: true })).toBeNull();
    expect(stageExplanation(["That Council adopt the policy."], { committee: true })).toBeNull();
  });
  it("doesn't call a direction to prepare bylaws final", () => {
    expect(stageExplanation(["Staff directed to prepare bylaws subject to conditions", "That Council direct staff to prepare the bylaws for adoption."])).toBeNull();
  });
  it("still explains readings", () => {
    expect(stageExplanation(["Bylaw 1613 (Second and Third Reading)"])).toMatch(/content and final wording/);
  });
  it("says a rescinding cancels a decision, without guessing why", () => {
    expect(stageExplanation(["That Council rescind its direction to prepare a permit bylaw and direct staff to seek a licensed operator."])).toBe("Council cancelled an earlier decision.");
    expect(stageExplanation(["That Council rescind third reading of Bylaw 2105."])).toBe("Council cancelled an earlier reading of the bylaw.");
  });
  it("tells committee meetings from Council's", () => {
    expect(isCommitteeItem({ meetings: { organizations: { name: "Community Advisory Committee" } } })).toBe(true);
    expect(isCommitteeItem({ meetings: { organizations: { name: "Council" } } })).toBe(false);
  });
});
