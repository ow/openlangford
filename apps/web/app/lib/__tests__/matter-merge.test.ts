import { describe, it, expect } from "vitest";
import { currentMatterIds, planMerge, type MatterMergeRow } from "../matter-merge";

const row = (id: number, first_seen: string | null, meta: Record<string, unknown> = {}): MatterMergeRow => ({
  id,
  first_seen,
  last_seen: first_seen,
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
      [412, row(412, "2016-01-01", { canonical_matter_id: 738 })],
      [738, row(738, "2016-01-01", { merged_matter_ids: [412] })],
      [1108, row(1108, "2018-01-01")],
    ]);
    expect(currentMatterIds([412, 738, 1108], byId)).toEqual([738, 1108]);
  });

  it("collapses to one matter when the proposal is already done", () => {
    const byId = new Map([
      [5, row(5, "2020-01-01", { canonical_matter_id: 6 })],
      [6, row(6, "2020-01-01")],
    ]);
    expect(currentMatterIds([5, 6], byId)).toEqual([6]);
  });

  it("follows alias chains and survives cycles", () => {
    const byId = new Map([
      [1, row(1, null, { canonical_matter_id: 2 })],
      [2, row(2, null, { canonical_matter_id: 3 })],
      [3, row(3, null)],
      [8, row(8, null, { canonical_matter_id: 9 })],
      [9, row(9, null, { canonical_matter_id: 8 })],
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
    expect(plan.mergedIds).toEqual([2]);
  });

  it("re-points aliases of an absorbed matter so no alias chains form", () => {
    const plan = planMerge([
      row(738, "2016-06-01", { merged_matter_ids: [412] }),
      row(1108, "2018-01-01", { merged_matter_ids: [1200] }),
      row(100, "2015-01-01", { merged_matter_ids: [50] }),
    ]);
    expect(plan.canonical.id).toBe(100);
    expect(plan.aliasIds).toEqual([738, 1108]);
    expect(plan.repointIds).toEqual([412, 1200]);
    expect(plan.mergedIds).toEqual([50, 412, 738, 1108, 1200]);
  });

  it("breaks first_seen ties by id and sorts missing dates last", () => {
    expect(planMerge([row(9, "2020-01-01"), row(4, "2020-01-01")]).canonical.id).toBe(4);
    expect(planMerge([row(1, null), row(2, "2020-01-01")]).canonical.id).toBe(2);
  });

  it("carries the latest last_seen to the canonical matter", () => {
    const plan = planMerge([
      { id: 1, first_seen: "2020-01-01", last_seen: "2020-02-01", meta: {} },
      { id: 2, first_seen: "2021-01-01", last_seen: "2023-05-01", meta: {} },
    ]);
    expect(plan.lastSeen).toBe("2023-05-01");
  });
});
