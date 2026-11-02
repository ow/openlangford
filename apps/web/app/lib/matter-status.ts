/** Badge tone for a matter's status; null for "Active" or no status. */
export function matterStatusVariant(status: string | null | undefined) {
  if (!status || status === "Active") return null;
  if (/defeat|fail|withdraw|rescind|repeal/i.test(status)) return "danger" as const;
  if (/adopt|complete|approv|pass|closed|resolved/i.test(status)) return "success" as const;
  if (/pend|defer|tabled|hold/i.test(status)) return "warning" as const;
  return "muted" as const;
}

/** Two years with nothing on record. */
const QUIET_DAYS = 730;

/**
 * The year an "Active" matter last came up, when that was over two years ago: "Active" in the data means not
 * concluded (a rezoning given first reading in 2019 and never brought back), but a resident reads it as being worked
 * on now, so pages say "No activity since 2019" instead. Null for anything recent, concluded or undated.
 */
export function quietSince(status: string | null | undefined, lastSeen: string | null | undefined, now = new Date()): number | null {
  if (status !== "Active" || !lastSeen) return null;
  const last = new Date(lastSeen);
  if (Number.isNaN(last.getTime())) return null;
  return now.getTime() - last.getTime() > QUIET_DAYS * 86_400_000 ? last.getFullYear() : null;
}
