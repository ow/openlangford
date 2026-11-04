import { describe, it, expect } from "vitest";
import { currentMatterIds, openPairDecisions, planMerge, signalLabels, type MatterMergeRow } from "../matter-merge";

const row = (id: number, first_seen: string | null, meta: Record<string, unknown> = {}, merged_into: number | null = null): MatterMergeRow => ({
  id,
  first_seen,
  last_seen: first_seen,
  merged_into,
  meta,
});

describe("currentMatterIds", () => {
  it("keeps distinct visible matters", () => {
    const byId = new Map([
      [1, row(1, "2020-01-01")],
      [2, row(2, "2021-01-01")],
    ]);
    expect(currentMatterIds([2, 1], byId)).toEqual([1, 2]);
  });

  it("swaps an alias for its canonical matter", () => {
    // Proposal #1: 412 was aliased to 738 after the proposal was queued.
    const byId = new Map([
      [412, row(412, "2016-01-01", {}, 738)],
      [738, row(738, "2016-01-01")],
      [1108, row(1108, "2018-01-01")],
    ]);
    expect(currentMatterIds([412, 738, 1108], byId)).toEqual([738, 1108]);
  });

  it("collapses to one matter when the proposal is already done", () => {
    const byId = new Map([
      [5, row(5, "2020-01-01", {}, 6)],
      [6, row(6, "2020-01-01")],
    ]);
    expect(currentMatterIds([5, 6], byId)).toEqual([6]);
  });

  it("follows alias chains and survives cycles", () => {
    const byId = new Map([
      [1, row(1, null, {}, 2)],
      [2, row(2, null, {}, 3)],
      [3, row(3, null)],
      [8, row(8, null, {}, 9)],
      [9, row(9, null, {}, 8)],
    ]);
    expect(currentMatterIds([1], byId)).toEqual([3]);
    expect(currentMatterIds([8], byId)).toHaveLength(1);
  });

  it("drops hidden and missing matters", () => {
    const byId = new Map([
      [97, row(97, "2019-01-01")],
      [293, row(293, "2019-01-01", { hidden: "container" })],
    ]);
    expect(currentMatterIds([97, 293, 404], byId)).toEqual([97]);
  });
});

describe("planMerge", () => {
  it("makes the earliest matter canonical", () => {
    const plan = planMerge([row(2, "2021-01-01"), row(1, "2020-01-01")]);
    expect(plan.canonical.id).toBe(1);
    expect(plan.aliasIds).toEqual([2]);
  });

  it("breaks first_seen ties by id and sorts missing dates last", () => {
    expect(planMerge([row(9, "2020-01-01"), row(4, "2020-01-01")]).canonical.id).toBe(4);
    expect(planMerge([row(1, null), row(2, "2020-01-01")]).canonical.id).toBe(2);
  });
});

describe("signalLabels", () => {
  it("translates resolver codes", () => {
    expect(
      signalLabels([
        { signals: ["address"] },
        { signals: ["street:glen lake,title:0.80"] },
        { signals: ["key:BYLAW 2041"] },
        { reason: "same identifier" },
      ]),
    ).toEqual(["Same address", "Same street: Glen Lake", "Similar titles", "Same number: Bylaw 2041", "Same identifier"]);
  });

  it("deduplicates across pairs", () => {
    expect(signalLabels([{ signals: ["address"] }, { signals: ["address"] }])).toEqual(["Same address"]);
  });
});

describe("openPairDecisions", () => {
  it("drops pairs that were already merged and maps aliases to canonicals", () => {
    // Proposal #1: the 412-738 pair is done; 412-1108 and 738-1108 both now mean 738-1108.
    const byId = new Map([
      [412, row(412, "2016-01-01", {}, 738)],
      [738, row(738, "2016-01-01")],
      [1108, row(1108, "2021-01-01")],
    ]);
    const decisions = [
      { a: 412, b: 738, verdict: "same_matter" as const, confidence: 1, reason: "same identifier" },
      { a: 412, b: 1108, verdict: "same_matter" as const, confidence: 0.81, probabilities: { same_matter: 0.51 } },
      { a: 738, b: 1108, verdict: "same_matter" as const, confidence: 0.8, probabilities: { same_matter: 0.47 } },
    ];
    const open = openPairDecisions(decisions, [738, 1108], byId);
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ a: 738, b: 1108, confidence: 0.81 });
  });
});
