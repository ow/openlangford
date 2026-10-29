/**
 * Search ranking for matters, shared by the quick search (search box / ⌘K) and the full
 * /search matter results. Text match sets the base; the current, in-force matter then
 * beats an old or repealed one with the same name (e.g. "purchasing policy" → the 2026
 * POL-0185-FIN policy, not the 2017 one it replaced).
 */
export interface RankableMatter {
  title?: string | null;
  identifier?: string | null;
  status?: string | null;
  last_seen?: string | null;
  meta?: any;
}

const IN_FORCE = new Set(["adopted", "approved", "enacted", "in effect"]);
const RETIRED = new Set(["repealed", "rescinded", "withdrawn", "superseded", "replaced", "denied", "defeated"]);

/** +4 adopted/approved, +2 active, −20 repealed/rescinded/withdrawn/superseded, else 0. */
export function matterStatusBoost(status?: string | null): number {
  const s = (status || "").trim().toLowerCase();
  if (IN_FORCE.has(s)) return 4;
  if (s === "active") return 2;
  if (RETIRED.has(s)) return -20;
  return 0;
}

/** +4 seen in the last two years, +2 in the last five, else 0. */
export function matterRecencyBoost(lastSeen?: string | null, now: Date = new Date()): number {
  if (!lastSeen) return 0;
  const t = Date.parse(lastSeen);
  if (Number.isNaN(t)) return 0;
  const years = (now.getTime() - t) / (365.25 * 24 * 3600 * 1000);
  if (years <= 2) return 4;
  if (years <= 5) return 2;
  return 0;
}

/**
 * "pol-0185" or "pol-0185-fin" against "POL-0185-FIN" (or one part of a combined
 * "POL-0062-FIN; POL-0180-FIN"). Needs at least one digit so "pol" alone doesn't match.
 */
export function identifierMatches(identifier: string | null | undefined, q: string): boolean {
  const query = q.trim().toLowerCase().replace(/\s+/g, "");
  if (!identifier || query.length < 3 || !/\d/.test(query)) return false;
  return identifier
    .toLowerCase()
    .split(/[;,]/)
    .map((part) => part.trim().replace(/\s+/g, ""))
    .some((part) => part === query || part.startsWith(`${query}-`));
}

/**
 * Text score. Only the shown title (the short display title, else the raw title) counts as
 * an exact hit; either title can match as a prefix. Raw titles are often generic ("Purchasing
 * Policy"), so an old matter must not win outright just because its raw title is the query.
 */
function textScore(m: RankableMatter, q: string): number {
  const display = typeof m.meta?.display_title === "string" && m.meta.display_title.trim() ? m.meta.display_title : null;
  const shown = (display || m.title || "").trim().toLowerCase();
  if (shown === q) return 90;
  const raw = (m.title || "").trim().toLowerCase();
  if (shown.startsWith(q) || raw.startsWith(q)) return 70;
  return 55;
}

/** Quick-search score for a matter row that already matched `q` (normalized, lower-case). */
export function matterQuickScore(m: RankableMatter, q: string, now: Date = new Date()): { score: number; exact: boolean } {
  if (identifierMatches(m.identifier, q)) return { score: 97, exact: true };
  const base = textScore(m, q);
  return { score: base + matterStatusBoost(m.status) + matterRecencyBoost(m.last_seen, now), exact: base >= 90 };
}
