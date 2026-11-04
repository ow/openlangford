/** Plain words for the staff actions recorded in staff_actions (requireRole logs every staff change). */

const LABELS: Record<string, string> = {
  check: "Ran a page check",
  reviewed: "Marked a page reviewed",
  needs_work: "Asked the agent to fix a page",
  clear: "Cleared a page review",
  reject: "Rejected a suggestion",
  hide_page: "Hid a page from the public",
  unhide_page: "Made a page public again",
  remove_entry: "Removed an entry from a page",
  find_missing: "Searched for missing entries",
  add_issue: "Added an issue",
  flag_note: "Added a note",
  internal_note: "Added an internal note",
  handled: "Marked handled",
  handle: "Marked handled",
  merge: "Merged duplicate topics",
  dismiss: "Dismissed",
  publish: "Published",
  unpublish: "Unpublished",
  approve: "Approved",
  discard: "Discarded a draft",
  place: "Placed a letter",
  draft_rule: "Drafted a review rule",
  approve_rule: "Approved a review rule",
  reject_rule: "Rejected a review rule",
  assign_alias: "Assigned a speaker alias",
  assign_person_segments: "Assigned transcript lines to a person",
  relabel_segments: "Relabelled transcript lines",
  split_segment: "Split a transcript line",
};

const words = (value: string) => value.replace(/[_-]+/g, " ").replace(/^\w/, (c) => c.toUpperCase());

/** "Agreed with a flag", "Agent: moved an item", or the action name in words. */
export function staffActionLabel(action: string | null, detail: Record<string, string> = {}): string {
  if (!action) return "Made a change";
  if (action.startsWith("agent:")) return `Agent: ${words(action.slice("agent:".length)).toLowerCase()}`;
  if (action === "rate") {
    if (detail.verdict === "agree") return "Agreed with a flag";
    if (detail.verdict === "disagree") return "Disagreed with a flag";
    return "Cleared a flag rating";
  }
  if (action === "accept") return detail.agree === "0" ? "Rejected a found entry" : "Accepted a found entry";
  return LABELS[action] ?? words(action);
}

/** The public page an action was about: the page a review-bar request named, or the page it was made on. */
export function staffActionPage(path: string, detail: Record<string, string> = {}): string | null {
  const named = detail.path;
  if (named && named.startsWith("/") && !named.startsWith("//")) return named;
  return path.startsWith("/api/") || path.startsWith("/admin") ? null : path;
}
