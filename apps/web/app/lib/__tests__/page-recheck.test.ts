import { describe, expect, it } from "vitest";
import { applyRecheck, recheckSummary } from "../page-recheck";
import type { PageFlag } from "../page-review-types";

const flag = (key: string | null, extra: Partial<PageFlag> = {}): PageFlag =>
  ({ key, problem: "unsupported", reason: "r", excerpt: "e", verdict: "agree", fixed: true, ...extra });
const at = "2026-11-06T00:00:00Z";

describe("applyRecheck", () => {
  const flags = [flag("agenda-1"), flag(null), flag("mention-5"), flag("agenda-9", { fixed: false })];

  it("keeps fixes that hold and counts removals and moves as holding without a re-read", () => {
    const verdicts = new Map([["line-1", { verdict: "supported", reason: "" }], ["summary-0", { verdict: "cannot_check", reason: "" }]]);
    const out = applyRecheck(flags, [0, 1, 2], new Map([[0, ["line-1"]], [1, ["summary-0"]]]), verdicts, at);
    expect(out.held).toBe(3);
    expect(out.total).toBe(3);
    expect(out.flags[0]).toMatchObject({ fixed: true, recheck: { holds: true, checked: true } });
    expect(out.flags[2].recheck).toMatchObject({ holds: true, checked: false });
    expect(out.flags[3].recheck).toBeUndefined();
  });

  it("reopens a fix whose new text the records don't back", () => {
    const verdicts = new Map([["line-1", { verdict: "contradicted", reason: "The vote was 4-3." }], ["status", { verdict: "supported", reason: "" }]]);
    const out = applyRecheck(flags, [0, 1], new Map([[0, ["line-1"]], [1, ["status"]]]), verdicts, at);
    expect(out.held).toBe(1);
    expect(out.failed).toEqual([{ index: 0, reason: "The vote was 4-3." }]);
    expect(out.flags[0]).toMatchObject({ fixed: false, verdict: "agree", recheck: { holds: false, reason: "The vote was 4-3." } });
    expect(out.flags[1].fixed).toBe(true);
  });

  it("writes the note's check paragraph", () => {
    expect(recheckSummary(3, 3, 3, [])).toBe("Checked: 3 of 3 fixes hold.");
    expect(recheckSummary(1, 1, 0, [])).toBe("Checked: 1 of 1 fix holds.");
    expect(recheckSummary(2, 3, 1, ["Not backed on agenda-1: x"])).toBe(
      "Checked: 2 of 3 fixes hold. 1 was read again against the records; the rest show on the page.\n• Doesn't hold: Not backed on agenda-1: x");
    expect(recheckSummary(0, 0, 0, [])).toBe("");
  });
});
