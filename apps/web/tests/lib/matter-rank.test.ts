import { describe, expect, it } from "vitest";
import { identifierMatches, matterQuickScore, matterStatusBoost } from "../../app/lib/matter-rank";

const NOW = new Date("2026-10-29T12:00:00Z");

// Live rows (October 2026) that all match "purchasing policy".
const ROWS = [
  { id: 1791, title: "Purchasing Policy", identifier: "POL-0031-FIN", status: "Active", last_seen: "2017-05-09", meta: { display_title: "Purchasing policy update" } },
  { id: 3055, title: "Replacement purchasing policy", identifier: "1200-01; Policy No. 1200.00.001", status: "Approved", last_seen: "2009-11-16", meta: { display_title: "Purchasing policy replacement" } },
  { id: 1571, title: "Monthly accounts payable and purchasing policy updates", identifier: null, status: "Completed", last_seen: "2017-05-15", meta: { display_title: "Accounts payable and purchasing policy" } },
  { id: 46, title: "Purchasing Policy - (POL-0185-FIN)", identifier: "POL-0185-FIN", status: "Adopted", last_seen: "2026-06-01", meta: { display_title: "City purchasing policy" } },
];

const rank = (q: string, rows = ROWS) =>
  rows
    .map((m) => ({ id: m.id, ...matterQuickScore(m, q, NOW) }))
    .sort((a, b) => b.score - a.score);

describe("matter search ranking", () => {
  it("puts the current adopted purchasing policy first", () => {
    const order = rank("purchasing policy");
    expect(order[0].id).toBe(46);
    expect(order.map((r) => r.id)).toEqual([46, 3055, 1791, 1571]);
  });

  it("demotes a repealed policy below its replacement", () => {
    const repealed = ROWS.map((m) => (m.id === 1791 ? { ...m, status: "Repealed" } : m));
    const order = rank("purchasing policy", repealed);
    expect(order[0].id).toBe(46);
    expect(order[order.length - 1].id).toBe(1791);
  });

  it("treats an exact policy number as an exact hit", () => {
    for (const q of ["pol-0185", "pol-0185-fin", "POL-0185-FIN"]) {
      const [top] = rank(q.toLowerCase());
      expect(top).toMatchObject({ id: 46, exact: true });
    }
  });

  it("matches one part of a combined identifier, not a bare prefix", () => {
    expect(identifierMatches("POL-0062-FIN; POL-0180-FIN", "pol-0180")).toBe(true);
    expect(identifierMatches("POL-0185-FIN", "pol-018")).toBe(false);
    expect(identifierMatches("POL-0185-FIN", "pol")).toBe(false);
  });

  it("scores statuses", () => {
    expect(matterStatusBoost("Adopted")).toBeGreaterThan(matterStatusBoost("Active"));
    for (const s of ["Repealed", "Rescinded", "Withdrawn", "Superseded"]) expect(matterStatusBoost(s)).toBeLessThan(0);
  });

  it("keeps an exact title match exact", () => {
    expect(matterQuickScore(ROWS[3], "city purchasing policy", NOW)).toMatchObject({ exact: true });
    expect(matterQuickScore(ROWS[0], "purchasing policy update", NOW).exact).toBe(true);
    // A generic raw title alone is not an exact hit.
    expect(matterQuickScore(ROWS[0], "purchasing policy", NOW).exact).toBe(false);
  });
});
