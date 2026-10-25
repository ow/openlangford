/**
 * Merge proposals are snapshots: by the time someone reviews one, the resolver
 * or another approval may have aliased some of its matters, or a matter may
 * have been hidden. These helpers work from the matters as they are now.
 */

export type MatterMergeRow = {
  id: number;
  first_seen: string | null;
  last_seen: string | null;
  meta: Record<string, any> | null;
};

/** Matches the public listings: any `meta.hidden` value hides a matter. */
export function isHiddenMatter(meta: Record<string, any> | null | undefined) {
  return meta?.hidden != null;
}

/** Follows `canonical_matter_id` to the matter that currently owns this one. */
export function canonicalMatterId(id: number, byId: Map<number, MatterMergeRow>) {
  let current = id;
  const seen = new Set<number>();
  while (!seen.has(current)) {
    seen.add(current);
    const next = Number(byId.get(current)?.meta?.canonical_matter_id);
    if (!next) break;
    current = next;
  }
  return current;
}

/**
 * The distinct, visible matters a proposal would merge today. Fewer than two
 * means there's nothing left to decide.
 */
export function currentMatterIds(ids: number[], byId: Map<number, MatterMergeRow>) {
  const result = new Set<number>();
  for (const id of ids) {
    const canonical = canonicalMatterId(id, byId);
    const row = byId.get(canonical);
    if (row && !isHiddenMatter(row.meta)) result.add(canonical);
  }
  return [...result].sort((a, b) => a - b);
}

/**
 * Earliest matter becomes canonical; the rest become its aliases, and any
 * aliases they already had move to the new canonical so lookups stay one hop.
 */
export function planMerge(rows: MatterMergeRow[]) {
  const sorted = [...rows].sort(
    (x, y) =>
      String(x.first_seen || "9999").localeCompare(String(y.first_seen || "9999")) || x.id - y.id,
  );
  const [canonical, ...aliases] = sorted;
  const aliasIds = aliases.map((a) => a.id);
  const repointIds = aliases.flatMap((a) => (a.meta?.merged_matter_ids as number[] | undefined) || []);
  const mergedIds = [
    ...new Set([...(canonical.meta?.merged_matter_ids || []), ...aliasIds, ...repointIds]),
  ].sort((x, y) => x - y);
  const lastSeen = rows.map((r) => r.last_seen || "").sort().pop() || canonical.last_seen;
  return { canonical, aliases, aliasIds, repointIds: [...new Set(repointIds)].sort((x, y) => x - y), mergedIds, lastSeen };
}
