import { describe, expect, it } from "vitest";
import { groupAuditRows } from "../../app/lib/staff-actions";

const row = (id: number, minute: number, action: string, extra: Partial<{ user_id: string; path: string; detail: Record<string, string> }> = {}) => ({
  id, created_at: new Date(Date.UTC(2026, 10, 4, 15, minute)).toISOString(), user_id: extra.user_id ?? "u1", role: "admin",
  action, path: extra.path ?? "/api/page-review", detail: extra.detail ?? { path: "/matters/a" },
});

describe("groupAuditRows", () => {
  it("folds one person's sitting on a page into one row, in the order the steps were taken", () => {
    // Newest first, as the log lists them.
    const groups = groupAuditRows([
      row(5, 20, "reviewed"),
      row(4, 15, "needs_work"),
      row(3, 12, "rate", { detail: { path: "/matters/a", verdict: "agree" } }),
      row(2, 11, "rate", { detail: { path: "/matters/a", verdict: "agree" } }),
      row(1, 10, "check"),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].steps).toEqual([
      { label: "Ran a page check", count: 1 },
      { label: "Agreed with a flag", count: 2 },
      { label: "Asked the agent to fix a page", count: 1 },
      { label: "Marked a page reviewed", count: 1 },
    ]);
    expect(groups[0].page).toBe("/matters/a");
    expect([groups[0].first, groups[0].last]).toEqual([row(1, 10, "").created_at, row(5, 20, "").created_at]);
  });

  it("starts a new row for another page, another person, a long gap, or an action with no page", () => {
    const groups = groupAuditRows([
      row(6, 59, "check", { path: "/api/page-review", detail: {} }),
      row(5, 58, "check", { path: "/api/page-review", detail: {} }),
      row(4, 50, "check"),
      row(3, 10, "check"),
      row(2, 9, "check", { user_id: "u2" }),
      row(1, 8, "check", { detail: { path: "/matters/b" } }),
    ]);
    expect(groups.map((g) => g.rows.map((r) => r.id))).toEqual([[6], [5], [4], [3], [2], [1]]);
  });

  it("groups actions made on the same admin page", () => {
    const groups = groupAuditRows([row(2, 14, "approve", { path: "/admin/reports", detail: {} }), row(1, 10, "assess", { path: "/admin/reports", detail: {} })]);
    expect(groups).toHaveLength(1);
    expect(groups[0].steps.map((s) => s.label)).toEqual(["Assess", "Approved"]);
  });
});
