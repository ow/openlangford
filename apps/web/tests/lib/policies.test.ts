import { describe, expect, it } from "vitest";
import { groupPolicies, isRetiredPolicy, policyNumbers } from "../../app/lib/policies";

describe("policies", () => {
  it("extracts policy numbers from combined identifiers", () => {
    expect(policyNumbers("POL-0185-FIN")).toEqual(["POL-0185-FIN"]);
    expect(policyNumbers("POL-0062-FIN; POL-0180-FIN")).toEqual(["POL-0062-FIN", "POL-0180-FIN"]);
    expect(policyNumbers("Policy POL-0166")).toEqual(["POL-0166"]);
    expect(policyNumbers("POL-0166-Plan")).toEqual(["POL-0166-PLAN"]);
    expect(policyNumbers("POL-0003-ENG; Bylaw No. 26")).toEqual(["POL-0003-ENG"]);
    expect(policyNumbers("Bylaw No. 2110")).toEqual([]);
  });

  it("groups replaced policies after current ones, newest first", () => {
    const { current, replaced } = groupPolicies([
      { id: 1791, status: "Repealed", last_seen: "2017-05-09" },
      { id: 310, status: "Approved", last_seen: "2019-02-04" },
      { id: 46, status: "Adopted", last_seen: "2026-06-01" },
      { id: 9, status: "Rescinded", last_seen: "2020-01-01" },
    ]);
    expect(current.map((p) => p.id)).toEqual([46, 310]);
    expect(replaced.map((p) => p.id)).toEqual([9, 1791]);
    expect(isRetiredPolicy("Superseded")).toBe(true);
    expect(isRetiredPolicy("Active")).toBe(false);
  });
});
