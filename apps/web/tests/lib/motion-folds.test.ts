import { describe, expect, it } from "vitest";
import { withoutFoldedMotions } from "../../app/lib/motion-utils";

describe("withoutFoldedMotions", () => {
  it("leaves out a motion folded into another under the same item, and keeps it when that one isn't there", () => {
    const motions = [{ id: 1, meta: { amended_by: 2 } }, { id: 2, meta: {} }, { id: 3, meta: { duplicate_of: 4 } }, { id: 4 }, { id: 5, meta: { amended_by: 99 } }];
    expect(withoutFoldedMotions(motions).map((m) => m.id)).toEqual([2, 4, 5]);
  });
});
