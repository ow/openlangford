import { describe, expect, it } from "vitest";
import { isCommitteeItem, stageExplanation, stageLineFor, stepNote } from "../timeline-step";

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
  it("doesn't take a condition set before adoption or a hearing for that step", () => {
    expect(stageExplanation(["Stormwater improvement commitment required before rezoning adoption", "1. Direct the applicant provide, prior to Bylaw Adoption, a Section 219 covenant. 2. Consider first reading of Bylaw No. 1232."])).toMatch(/^Introduced/);
    expect(stageExplanation(["That the applicant provide, prior to Public Hearing, an arborist report."])).toBeNull();
    expect(stageExplanation(["Stormwater improvements covenant required before Walfred Road rezoning adoption"])).toBeNull();
    expect(stageExplanation(["Walfred Road rezoning adopted", "That Council adopt Bylaw No. 1232."])).toBe("Final approval.");
  });
  it("uses a stage set by hand over the guess from the wording", () => {
    expect(stageExplanation(["Walfred Road rezoning adopted"], { chosen: "first" })).toMatch(/^Introduced/);
    expect(stageExplanation(["That Council adopt Bylaw No. 1232."], { chosen: "none" })).toBeNull();
    expect(stageExplanation(["That Council adopt Bylaw No. 1232."], { chosen: "not-a-stage" })).toBe("Final approval.");
  });
  it("still explains readings", () => {
    expect(stageExplanation(["Bylaw 1613 (Second and Third Reading)"])).toMatch(/content and final wording/);
  });
  it("says a rescinding cancels a decision, without guessing why", () => {
    expect(stageExplanation(["That Council rescind its direction to prepare a permit bylaw and direct staff to seek a licensed operator."])).toBe("Council cancelled an earlier decision.");
    expect(stageExplanation(["That Council rescind third reading of Bylaw 2105."])).toBe("Council cancelled an earlier reading of the bylaw.");
    expect(stageExplanation(["That Council rescind Adoption, Third, Second and First Reading of Bylaw No. 1332."])).toBe("Council cancelled the bylaw's adoption and its readings.");
  });
  it("tells committee meetings from Council's", () => {
    expect(isCommitteeItem({ meetings: { organizations: { name: "Community Advisory Committee" } } })).toBe(true);
    expect(isCommitteeItem({ meetings: { organizations: { name: "Council" } } })).toBe(false);
  });
});

describe("what a step says under its title", () => {
  it("prefers the item's own summary to the stage line", () => {
    expect(stepNote({ stage: "Final approval.", title: "Latecomer payment interest-rate bylaw made final", summary: "Adopted the bylaw establishing interest rates for latecomer payments." }))
      .toEqual({ kind: "summary", text: "Adopted the bylaw establishing interest rates for latecomer payments." });
  });
  it("ignores a summary that only repeats the title", () => {
    expect(stepNote({ stage: null, title: "Council adopts the policy", summary: "Council adopts the policy." })).toBeNull();
  });
  it("drops \"Final approval.\" beside a title that already says final", () => {
    for (const title of ["New latecomer payment interest-rate bylaw made final", "Council adopts park sponsorship policy", "Rezoning approved"]) {
      expect(stageLineFor("Final approval.", title)).toBeNull();
      expect(stepNote({ stage: "Final approval.", title, summary: null })).toBeNull();
    }
  });
  it("keeps \"Final approval.\" when the title doesn't say it, and keeps the lines that teach a term", () => {
    expect(stageLineFor("Final approval.", "Latecomer bylaw No. 1334")).toBe("Final approval.");
    expect(stepNote({ stage: "Introduced to council. A bylaw needs several readings before it becomes law.", title: "Council gave first reading", summary: null }))
      .toEqual({ kind: "stage", text: "Introduced to council. A bylaw needs several readings before it becomes law." });
  });
});
