/** Vote-by-vote grid of split decisions: who voted which way on each contested motion. */

export type MatrixVote = "Yes" | "No" | "Recused";
export type MatrixCell = "yes" | "no" | "recused" | "absent" | "off";
export type ContestedMotion = {
  id: number;
  date: string;
  meetingId: number;
  meetingSlug: string | null;
  summary: string;
  result: string | null;
  votes: Record<number, MatrixVote>;
};

/** Same vote vocabulary the alignment matrix counts, plus recusals (which it ignores). */
export function normalizeVote(vote: string | null | undefined, recusalReason?: string | null): MatrixVote | null {
  if (recusalReason || /recus|conflict/i.test(vote || "")) return "Recused";
  if (vote === "Yes" || vote === "In Favour") return "Yes";
  if (vote === "No" || vote === "Opposed") return "No";
  return null;
}

/** Motion ids with at least one Yes and one No among the counted votes. */
export function contestedMotionIds(votes: { motion_id: number; vote: string }[]): number[] {
  const seen = new Map<number, Set<MatrixVote>>();
  for (const v of votes) {
    const n = normalizeVote(v.vote);
    if (n !== "Yes" && n !== "No") continue;
    const set = seen.get(v.motion_id) || new Set();
    set.add(n);
    seen.set(v.motion_id, set);
  }
  return [...seen].filter(([, s]) => s.size === 2).map(([id]) => id);
}

type Member = { id: number; name: string };

/**
 * Rows = members, columns = this range's split motions (oldest first). A member who
 * served that day but has no recorded choice is "absent" (absent or no record); one
 * not on council that day is "off". A motion only split by non-members is dropped.
 */
export function buildVoteMatrix<M extends Member>(
  motions: ContestedMotion[],
  members: M[],
  { start, end, servedOn }: { start: string; end: string; servedOn: (personId: number, date: string) => boolean },
) {
  const ids = new Set(members.map((m) => m.id));
  const columns = motions
    .filter((m) => m.date >= start && m.date <= end)
    .filter((m) => {
      const cast = Object.entries(m.votes).filter(([p]) => ids.has(Number(p))).map(([, v]) => v);
      return cast.includes("Yes") && cast.includes("No");
    })
    .sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id);
  const rows = members.map((member) => {
    const cells: MatrixCell[] = columns.map((m) => {
      const v = m.votes[member.id];
      if (v === "Yes") return "yes";
      if (v === "No") return "no";
      if (v === "Recused") return "recused";
      return servedOn(member.id, m.date) ? "absent" : "off";
    });
    return { member, cells, no: cells.filter((c) => c === "no").length, cast: cells.filter((c) => c === "yes" || c === "no").length };
  });
  return { columns, rows };
}

/** Page of at most `size` columns; page 0 is the most recent. */
export function columnPage(total: number, size: number, page: number) {
  const pages = Math.max(1, Math.ceil(total / size));
  const p = Math.min(Math.max(page, 0), pages - 1);
  const to = total - p * size;
  return { from: Math.max(0, to - size), to, page: p, pages };
}
