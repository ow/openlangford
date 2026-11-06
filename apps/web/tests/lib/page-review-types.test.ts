import { describe, expect, it } from "vitest";
import { keepStaffRatings, type PageFlag } from "../../app/lib/page-review-types";

const flag = (verdict: PageFlag["verdict"], extra: Partial<PageFlag> = {}): PageFlag =>
  ({ key: "agenda-1", problem: "generic_text", reason: "r", excerpt: "e", verdict, ...extra });

describe("keepStaffRatings", () => {
  it("keeps ratings, notes and handled marks staff gave while the agent ran", () => {
    const mine = [flag("agree", { fixed: true, recheck: { holds: true, at: "t", checked: true } }), flag(null), flag(null), flag(null)];
    const now = [flag("agree"), flag("agree"), flag("agree", { note: "move it" }), flag("disagree", { fixed: true })];
    const out = keepStaffRatings(now, mine);
    expect(out.map((f) => f.verdict)).toEqual(["agree", "agree", "agree", "disagree"]);
    expect(out[0].fixed).toBe(true);
    expect(out[0].recheck?.holds).toBe(true);  // the agent's own fields stay
    expect(out[2].note).toBe("move it");
    expect(out[3].fixed).toBe(true);
  });

  it("leaves a list a new check replaced alone", () => {
    const now = [flag(null), flag(null)];
    expect(keepStaffRatings(now, [flag("agree", { fixed: true })])).toBe(now);
  });

  it("takes the agent's list when there was none", () => {
    expect(keepStaffRatings(null, [flag("agree")])).toEqual([]);
  });
});
