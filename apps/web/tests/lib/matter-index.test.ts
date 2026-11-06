import { describe, expect, it } from "vitest";
import { orderLike, pageOf } from "../../app/lib/matter-index";

describe("matter index paging", () => {
  const index = Array.from({ length: 120 }, (_, i) => ({ id: i + 1 }));
  it("slices a page of the index", () => {
    expect(pageOf(index, 1)).toHaveLength(50);
    expect(pageOf(index, 3).map((m) => m.id)[0]).toBe(101);
    expect(pageOf(index, 3)).toHaveLength(20);
    expect(pageOf(index, 4)).toEqual([]);
  });
  it("puts fetched rows back in index order and ignores rows off the page", () => {
    const rows = [{ id: 3, t: "c" }, { id: 1, t: "a" }, { id: 99, t: "x" }];
    expect(orderLike(rows, [{ id: 1 }, { id: 2 }, { id: 3 }]).map((r) => r.t)).toEqual(["a", "c"]);
  });
});
