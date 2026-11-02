import { describe, expect, it } from "vitest";
import { isResolved } from "../reviewed-pages.server";

describe("isResolved", () => {
  it("counts a page with no flags, or only fixed or dismissed ones, as resolved", () => {
    expect(isResolved([])).toBe(true);
    expect(isResolved(null)).toBe(true);
    expect(isResolved([{ fixed: true, verdict: "agree" } as any, { verdict: "disagree" } as any])).toBe(true);
  });
  it("keeps a page with any open flag off the list", () => {
    expect(isResolved([{ fixed: true } as any, { verdict: null } as any])).toBe(false);
    expect(isResolved([{ verdict: "agree" } as any])).toBe(false);
  });
});
