import { describe, expect, it } from "vitest";
import { buildVoteMatrix, columnPage, contestedMotionIds, normalizeVote, type ContestedMotion } from "../../app/lib/vote-matrix";
import { isProceduralMotion } from "../../app/lib/motion-utils";

const motion = (id: number, date: string, votes: ContestedMotion["votes"]): ContestedMotion => ({
  id, date, meetingId: id * 10, meetingSlug: null, summary: `Motion ${id}`, result: "CARRIED", votes,
});
const members = [{ id: 1, name: "A" }, { id: 2, name: "B" }, { id: 3, name: "C" }];

describe("vote matrix", () => {
  it("normalizes vote values the alignment page counts, plus recusals", () => {
    expect(normalizeVote("In Favour")).toBe("Yes");
    expect(normalizeVote("Opposed")).toBe("No");
    expect(normalizeVote("Yes", "Owns adjacent property")).toBe("Recused");
    expect(normalizeVote("Recused")).toBe("Recused");
    expect(normalizeVote("Abstain")).toBeNull();
  });

  it("picks only motions with both a Yes and a No", () => {
    const votes = [
      { motion_id: 1, vote: "Yes" }, { motion_id: 1, vote: "Yes" },
      { motion_id: 2, vote: "Yes" }, { motion_id: 2, vote: "Opposed" },
      { motion_id: 3, vote: "No" },
    ];
    expect(contestedMotionIds(votes)).toEqual([2]);
  });

  it("builds rows by member with absent, recused and not-serving cells, oldest first", () => {
    const servedOn = (p: number, d: string) => !(p === 3 && d < "2026-02-01");
    const { columns, rows } = buildVoteMatrix(
      [
        motion(2, "2026-03-01", { 1: "Yes", 2: "No", 3: "Recused" }),
        motion(1, "2026-01-15", { 1: "Yes", 2: "No" }),
        motion(3, "2026-03-05", { 1: "Yes", 2: "Yes", 3: "Yes" }),
        motion(4, "2025-12-01", { 1: "Yes", 2: "No" }),
        motion(5, "2026-04-01", { 1: "No", 9: "Yes" }),
      ],
      members,
      { start: "2026-01-01", end: "2026-12-31", servedOn },
    );
    expect(columns.map((c) => c.id)).toEqual([1, 2]);
    expect(rows.map((r) => r.cells)).toEqual([["yes", "yes"], ["no", "no"], ["off", "recused"]]);
    expect(rows[1]).toMatchObject({ no: 2, cast: 2 });
    const absent = buildVoteMatrix([motion(1, "2026-01-15", { 1: "Yes", 2: "No" })], members, { start: "2026-01-01", end: "2026-12-31", servedOn: () => true });
    expect(absent.rows[2].cells).toEqual(["absent"]);
  });

  it("pages columns from the most recent end", () => {
    expect(columnPage(130, 60, 0)).toEqual({ from: 70, to: 130, page: 0, pages: 3 });
    expect(columnPage(130, 60, 2)).toEqual({ from: 0, to: 10, page: 2, pages: 3 });
    expect(columnPage(130, 60, 9).page).toBe(2);
    expect(columnPage(0, 60, 0)).toEqual({ from: 0, to: 0, page: 0, pages: 1 });
  });

  it("excludes procedural motions by the meeting-page rule", () => {
    expect(isProceduralMotion({ result: "CARRIED", text_content: "THAT the meeting adjourn" })).toBe(true);
    expect(isProceduralMotion({ result: "CARRIED", disposition: "Procedural" })).toBe(true);
    expect(isProceduralMotion({ result: "CARRIED" }, { category: "Procedural" })).toBe(true);
    expect(isProceduralMotion({ result: "DEFEATED", text_content: "THAT Council approve" }, { category: "Land Use" })).toBe(false);
  });
});
