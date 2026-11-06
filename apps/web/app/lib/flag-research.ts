import type { FlagResearch } from "./page-review-types";

/** One research finding as the fix agent reads it, or "" when there is none. */
export function researchLine(excerpt: string, r: FlagResearch | null | undefined): string {
  return r ? `RESEARCH on "${excerpt}": ${r.verdict}. ${r.explanation}${r.quote ? ` The record says: “${r.quote}”${r.ref ? ` (${r.ref})` : ""}` : ""}` : "";
}
