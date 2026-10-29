/**
 * Council policies have no table of their own: they are matters whose identifier carries a
 * policy number ("POL-0185-FIN", sometimes combined: "POL-0062-FIN; POL-0180-FIN").
 */
export interface PolicyRow {
  id: number;
  slug: string | null;
  title: string;
  identifier: string | null;
  status: string | null;
  category: string | null;
  last_seen: string | null;
  plain_english_summary: string | null;
  meta: { display_title?: string; status_line?: string } | null;
}

/** Policy numbers in an identifier, upper-cased: "Policy POL-0166" → ["POL-0166"]. */
export function policyNumbers(identifier: string | null | undefined): string[] {
  return [...new Set((identifier || "").match(/\bPOL-\d+(?:-[A-Z]+)?\b/gi)?.map((n) => n.toUpperCase()) ?? [])];
}

/** Statuses that mean the policy is no longer in force. */
export function isRetiredPolicy(status: string | null | undefined): boolean {
  return /repeal|rescind|withdraw|supersed|replaced/i.test(status || "");
}

/** Current policies first, then replaced ones; newest first within each group. */
export function groupPolicies<T extends Pick<PolicyRow, "status" | "last_seen">>(rows: T[]): { current: T[]; replaced: T[] } {
  const byDate = [...rows].sort((a, b) => (b.last_seen || "").localeCompare(a.last_seen || ""));
  return {
    current: byDate.filter((p) => !isRetiredPolicy(p.status)),
    replaced: byDate.filter((p) => isRetiredPolicy(p.status)),
  };
}
