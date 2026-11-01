/** Shared by the admin review bar (browser) and the page review and check services (server). */
export type PageReviewStatus = "reviewed" | "needs_work";
export type FlagProblem = "unclear_why" | "generic_text" | "different_story" | "duplicate" | "wrong_detail";
export type FlagVerdict = "agree" | "disagree";
export type PageFlag = { key: string | null; problem: FlagProblem; reason: string; excerpt: string; verdict: FlagVerdict | null };
export type PageReview = {
  path: string;
  kind: string;
  title: string | null;
  status: PageReviewStatus | null;
  note: string | null;
  reviewed_at: string | null;
  ai_flags: PageFlag[] | null;
  ai_page_issue: string | null;
  ai_checked_at: string | null;
};
