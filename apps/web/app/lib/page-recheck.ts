import { FLAG_PROBLEM_LABELS, type PageFlag } from "./page-review-types";

/** A verdict that means the text the fix wrote doesn't hold against the records. */
const DOUBTED = new Set(["not_in_record", "contradicted"]);

export type RecheckVerdicts = Map<string, { verdict: string; reason: string }>;

/**
 * Applies the fix agent's re-check to the flags it just fixed. `newlyFixed` are the indexes fixed in this run;
 * `scopes` maps each to the ids of the statements its fix wrote (the rewritten line, the summary and status). A fix
 * with none (a removal, a move, an answered question) can be seen on the page and counts as holding. A fix whose
 * statement the records don't back or contradict is reopened (fixed: false, still agreed) so a person sees it.
 */
export function applyRecheck(flags: PageFlag[], newlyFixed: number[], scopes: Map<number, string[]>, verdicts: RecheckVerdicts, at: string) {
  const updated = [...flags];
  const failed: { index: number; reason: string }[] = [];
  for (const index of newlyFixed) {
    const ids = scopes.get(index) || [];
    const bad = ids.map((id) => verdicts.get(id)).find((v) => v && DOUBTED.has(v.verdict));
    if (bad) {
      failed.push({ index, reason: bad.reason });
      updated[index] = { ...updated[index], fixed: false, recheck: { holds: false, at, checked: true, reason: bad.reason } };
    } else {
      updated[index] = { ...updated[index], recheck: { holds: true, at, checked: ids.some((id) => verdicts.has(id)) } };
    }
  }
  return { flags: updated, held: newlyFixed.length - failed.length, total: newlyFixed.length, failed };
}

/** The line the agent's note opens its check paragraph with, e.g. "Checked: 3 of 3 fixes hold." */
export function recheckSummary(held: number, total: number, reread: number, failures: string[]): string {
  if (!total) return "";
  const head = `Checked: ${held} of ${total} ${total === 1 ? "fix holds" : "fixes hold"}.`;
  return [head + (reread && reread < total ? ` ${reread} ${reread === 1 ? "was" : "were"} read again against the records; the rest show on the page.` : ""),
    ...failures.map((f) => `• Doesn't hold: ${f}`)].join("\n");
}

export const flagLabel = (f: PageFlag) => FLAG_PROBLEM_LABELS[f.problem];
