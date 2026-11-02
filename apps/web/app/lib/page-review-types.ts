/** Shared by the admin review bar (browser) and the page review and check services (server). */
export type PageReviewStatus = "reviewed" | "needs_work" | "fixing" | "fixed";
export type FlagProblem = "unclear_why" | "generic_text" | "different_story" | "duplicate" | "wrong_detail";
export type FlagVerdict = "agree" | "disagree";
export type PageFlag = {
  key: string | null; problem: FlagProblem; reason: string; excerpt: string; verdict: FlagVerdict | null;
  /** Set when the entry was removed (by staff or the fix agent): an agreed flag is then resolved. */
  fixed?: boolean;
};

/** A flag still needs attention until it's rated 👎 (fine) or rated 👍 and fixed. Reviewed waits for none. */
export function unresolvedFlags(flags: PageFlag[] | null | undefined) {
  return (flags || []).filter((f) => f.verdict === null || (f.verdict === "agree" && !f.fixed));
}
export type PageReview = {
  path: string;
  kind: string;
  title: string | null;
  status: PageReviewStatus | null;
  note: string | null;
  reviewed_at: string | null;
  ai_flags: PageFlag[] | null;
  ai_page_issue: string | null;
  ai_summary: string | null;
  ai_entries: number | null;
  ai_checked_at: string | null;
  agent_note: string | null;
  agent_at: string | null;
};

/** What a check looks for, shown in the review bar so a clean result says what was ruled out. */
export const FLAG_PROBLEM_LABELS: Record<FlagProblem, string> = {
  unclear_why: "Unclear why it's here",
  generic_text: "Generic text",
  different_story: "Different story",
  duplicate: "Duplicate",
  wrong_detail: "Contradicts the page",
};

/** "Nov 1, 6:09 PM" from a stored timestamp. */
export function reviewTime(iso: string | null | undefined) {
  if (!iso) return "";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
