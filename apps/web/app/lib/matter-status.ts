/** Badge tone for a matter's status; null for "Active" or no status. */
export function matterStatusVariant(status: string | null | undefined) {
  if (!status || status === "Active") return null;
  if (/defeat|fail|withdraw|rescind|repeal/i.test(status)) return "danger" as const;
  if (/adopt|complete|approv|pass|closed|resolved/i.test(status)) return "success" as const;
  if (/pend|defer|tabled|hold/i.test(status)) return "warning" as const;
  return "muted" as const;
}
