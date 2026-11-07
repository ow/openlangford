/** Shared by the admin review bar (browser) and the page review and check services (server). */
export type PageReviewStatus = "reviewed" | "needs_work" | "fixing" | "fixed";
export type FlagProblem = "unclear_why" | "generic_text" | "different_story" | "duplicate" | "wrong_detail" | "unsupported" | "editor_issue" | "page_issue";
export type FlagVerdict = "agree" | "disagree";
/** What researching a flagged statement in all of the City's records found (services/record-research.server.ts). */
export type FlagResearch = { verdict: "supported" | "contradicted" | "not_found"; explanation: string; quote: string | null; ref: string | null };
export type PageFlag = {
  key: string | null; problem: FlagProblem; reason: string; excerpt: string; verdict: FlagVerdict | null;
  /** Set when the entry was removed (by staff or the fix agent): an agreed flag is then resolved. */
  fixed?: boolean;
  /** Staff's instruction to the fix agent about this entry ("move it to the 2022 budget topic"). */
  note?: string | null;
  /** The check's proposed fix, which a thumbs-up approves ("Rewrite the status to say…"). */
  fix?: string | null;
  /** For a statement checked against the records: the research behind the flag, so the fix agent needn't redo it. `reason` stays the display text. */
  research?: FlagResearch;
  /** The fix agent's check of its own fix, in the same request: whether the new text holds against the records. */
  recheck?: { holds: boolean; at: string; /** True when the new text was read against the records; false for a removal or move, which shows on the page. */ checked: boolean; reason?: string };
};

/** A flag still needs attention until it's rated 👎 (fine) or rated 👍 and fixed. Reviewed waits for none. */
export function unresolvedFlags(flags: PageFlag[] | null | undefined) {
  return (flags || []).filter((f) => f.verdict === null || (f.verdict === "agree" && !f.fixed));
}
/** The fix agent's flags written back after its run, keeping what staff did to them while it ran: a rating, a note,
 * or marking one handled. (2026-11-06: "Yes to all" was still saving when Fix was pressed, and the agent's write-back
 * put three 👍s back to unrated, so the next Fix had nothing to do.) A list of a different length belongs to a new
 * check that replaced the agent's: it wins untouched. */
export function keepStaffRatings(current: PageFlag[] | null | undefined, mine: PageFlag[]): PageFlag[] {
  const now = current || [];
  if (now.length !== mine.length) return now;
  return mine.map((f, i) => ({
    ...f, verdict: now[i].verdict, fixed: !!(f.fixed || now[i].fixed), ...("note" in now[i] ? { note: now[i].note } : {}),
  }));
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
  /** Staff's own note on the page, for whoever reviews it next; never public. */
  internal_note?: string | null;
  internal_note_at?: string | null;
};

/** What a check looks for, shown in the review bar so a clean result says what was ruled out. */
export const FLAG_PROBLEM_LABELS: Record<FlagProblem, string> = {
  unclear_why: "Unclear why it's here",
  generic_text: "Generic text",
  different_story: "Different story",
  duplicate: "Duplicate",
  wrong_detail: "Contradicts the page",
  unsupported: "Not backed by the record",
  editor_issue: "Your issue",
  page_issue: "Whole page",
};

/** "Nov 1, 6:09 PM" from a stored timestamp. */
export function reviewTime(iso: string | null | undefined) {
  if (!iso) return "";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/** Pages the review tool leaves out: bylaws are imported as published, councillor pages aren't reviewed here,
 * documents are the City's own files, and other pages (home, lists, about) have nothing to check against records. */
export const UNREVIEWED_SECTIONS = ["bylaws", "people", "documents", "pages"] as const;

/** Only a single record's page: a topic, meeting, property, participant or election (not a list or a document). */
const REVIEWABLE_PAGE = /^\/(matters|meetings|properties|participants|elections)\/(?!closed$)[^/]+\/?$/;

export function isReviewable(path: string) {
  return REVIEWABLE_PAGE.test(path);
}

/** Disagreements with the check it takes before a problem type is worth a rule, or its rule worth another look. */
export const DRAFT_AFTER = 5, RECONSIDER_AFTER = 3;

/** The most pages one "Pre-check" queues. */
export const PRECHECK_MAX = 50;

/**
 * How the agent's note names an entry: by the date the page shows for it ("the June 21, 2010 entry"), read from
 * its flag's excerpt, since entry keys are database words. "this page" for a whole-page flag.
 */
export function entryLabel(key: string | null | undefined, flags: Pick<PageFlag, "key" | "excerpt">[]): string {
  if (!key) return "this page";
  const excerpt = flags.find((f) => f.key === key)?.excerpt ?? "";
  const date = excerpt.match(/^\s*([A-Z][a-z]+\.? \d{1,2}, \d{4})/)?.[1];
  if (date) return `the ${date} entry`;
  return key.startsWith("related-") ? "the related topic" : "the entry";
}
