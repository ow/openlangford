import { describe, expect, it } from "vitest";
import { entryLabel, keepStaffRatings, type PageFlag } from "../../app/lib/page-review-types";

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

describe("entryLabel", () => {
  const flags = [flag(null, { key: "mention-9481", excerpt: "June 21, 2010 · Discussed in another item · Bylaw NO. 1290" }),
    flag(null, { key: "agenda-7", excerpt: "no date here" })];
  it("names an entry by the date the page shows", () => {
    expect(entryLabel("mention-9481", flags)).toBe("the June 21, 2010 entry");
  });
  it("falls back when the excerpt has no date or the flag is for the whole page", () => {
    expect(entryLabel("agenda-7", flags)).toBe("the entry");
    expect(entryLabel("agenda-99", flags)).toBe("the entry");
    expect(entryLabel("related-3", flags)).toBe("the related topic");
    expect(entryLabel(null, flags)).toBe("this page");
  });
});

describe("entryLabel for meeting items", () => {
  it("names the item by its title, or falls back to the item", () => {
    const flags = [{ key: "item-4543", excerpt: "1.1 · 902 Walfred Rd Rezoning · Council proceeded with readings" }, { key: "item-4536", excerpt: "Summary of item 4536: Members of the public spoke" }];
    expect(entryLabel("item-4543", flags)).toBe('the "902 Walfred Rd Rezoning" item');
    expect(entryLabel("item-4536", flags)).toBe("the item");
  });
});
