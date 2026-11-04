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
  edit_topic: "Edited a topic's text or photo",
  reset_field: "Reset an edit to automatic",
  keep_edits: "Kept edits after new entries",
  assess: "Asked the agent to assess a report",
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

type AuditRow = { id: number; created_at: string; user_id: string; role: string; action: string | null; path: string; detail: Record<string, string> };

/** How far apart two actions can be and still read as one sitting on a page. */
const SITTING_MS = 30 * 60_000;

/** One person's run of actions on one page (rows newest first, as the log lists them): the steps in the order they
 * were taken, with repeats counted ("Agreed with a flag ×5"). A page is the public page an action was about, or else
 * the admin page it was made on; a bare API request with no page stays on its own. */
export function groupAuditRows<T extends AuditRow>(rows: T[]) {
  const groups: { id: number; first: string; last: string; user_id: string; role: string; page: string | null; path: string; rows: T[] }[] = [];
  for (const row of rows) {
    const page = staffActionPage(row.path, row.detail);
    const where = page ?? (row.path.startsWith("/api/") ? null : row.path);
    const prev = groups.at(-1);
    if (prev && where && (prev.page ?? prev.path) === where && prev.user_id === row.user_id
      && new Date(prev.first).getTime() - new Date(row.created_at).getTime() <= SITTING_MS) {
      prev.rows.push(row);
      prev.first = row.created_at;
    } else {
      groups.push({ id: row.id, first: row.created_at, last: row.created_at, user_id: row.user_id, role: row.role, page, path: row.path, rows: [row] });
    }
  }
  return groups.map((g) => {
    const steps: { label: string; count: number }[] = [];
    for (const row of [...g.rows].reverse()) {
      const label = staffActionLabel(row.action, row.detail);
      const last = steps.at(-1);
      if (last?.label === label) last.count++;
      else steps.push({ label, count: 1 });
    }
    return { ...g, steps };
  });
}
