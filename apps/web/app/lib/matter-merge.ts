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

export type MergeDecision = {
  a: number;
  b: number;
  verdict: "same_matter" | "same_project" | "different";
  confidence: number;
  probabilities?: Record<string, number>;
  signals?: string[];
  reason?: string;
};

function titleCase(text: string) {
  return text.replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Turns resolver signal codes ("street:glen lake", "key:BYLAW 2041") into reviewer-facing reasons. */
export function signalLabels(decisions: Pick<MergeDecision, "signals" | "reason">[]) {
  const labels = new Set<string>();
  for (const d of decisions) {
    if (d.reason === "same identifier") labels.add("Same identifier");
    for (const raw of d.signals || []) {
      for (const part of raw.split(",")) {
        const [kind, value] = part.split(/:(.*)/s);
        if (kind === "address") labels.add("Same address");
        else if (kind === "street" && value) labels.add(`Same street: ${titleCase(value)}`);
        else if (kind === "key" && value) labels.add(`Same number: ${value.replace(/^BYLAW\s*/i, "Bylaw ")}`);
        else if (kind === "title") labels.add("Similar titles");
      }
    }
  }
  return [...labels];
}

/**
 * The decisions that still matter: pairs between today's separate matters,
 * keeping the strongest decision per pair. Pairs the resolver already merged
 * (and so collapse onto one matter) drop out.
 */
export function openPairDecisions(
  decisions: MergeDecision[],
  currentIds: number[],
  byId: Map<number, MatterMergeRow>,
) {
  const open = new Set(currentIds);
  const best = new Map<string, MergeDecision>();
  for (const d of decisions) {
    const a = canonicalMatterId(d.a, byId);
    const b = canonicalMatterId(d.b, byId);
    if (a === b || !open.has(a) || !open.has(b)) continue;
    const key = [a, b].sort((x, y) => x - y).join("-");
    const current = best.get(key);
    if (!current || d.confidence > current.confidence) best.set(key, { ...d, a: Math.min(a, b), b: Math.max(a, b) });
  }
  return [...best.values()].sort((x, y) => x.a - y.a || x.b - y.b);
}
