/**
 * What a meeting page, card or the home page shows as the meeting's summary: the plain-language
 * highlights from the pipeline's meeting-highlights stage (meetings.meta.highlights.bullets,
 * written to docs/writing-style.md) when the meeting has them, else the original summary.
 * Loaders select `highlights:meta->highlights` (never the whole meta, which holds private data);
 * the detail pages pass `meta.highlights` through their allowlist.
 *
 * Version 2 highlights also carry `links`, aligned with `bullets`: `links[i]` lists phrases of
 * `bullets[i]` (exact substrings, in reading order) and the agenda item of the same meeting each
 * one is about. Pages turn them into `#item-{id}` links; older highlights simply have none.
 */
type WithSummary = { summary?: string | null; highlights?: any; meta?: { highlights?: any } | null };

export type HighlightLink = { text: string; agenda_item_id: number };
export type HighlightPoint = { text: string; links: HighlightLink[] };

export function meetingHighlights(m: WithSummary | null | undefined): string[] | null {
  return highlightPoints(m)?.map((p) => p.text) ?? null;
}

/**
 * Highlights with their item links, validated again here (the data is model output): a link must be a
 * non-empty substring found after the previous one, with a positive integer item id. Invalid links are
 * dropped, never the bullet.
 */
export function highlightPoints(m: WithSummary | null | undefined): HighlightPoint[] | null {
  const highlights = m?.highlights ?? m?.meta?.highlights;
  if (!Array.isArray(highlights?.bullets)) return null;
  const allLinks: unknown[] = Array.isArray(highlights.links) ? highlights.links : [];
  const points: HighlightPoint[] = [];
  highlights.bullets.forEach((raw: unknown, i: number) => {
    if (typeof raw !== "string" || raw.trim() === "") return;
    const text = raw.trim();
    const links: HighlightLink[] = [];
    let from = 0;
    const candidates = Array.isArray(allLinks[i]) ? (allLinks[i] as any[]) : [];
    for (const link of candidates) {
      const phrase = typeof link?.text === "string" ? link.text : "";
      const id = Number(link?.agenda_item_id);
      if (!phrase || !Number.isSafeInteger(id) || id <= 0) continue;
      const at = text.indexOf(phrase, from);
      if (at < 0) continue;
      links.push({ text: phrase, agenda_item_id: id });
      from = at + phrase.length;
    }
    points.push({ text, links });
  });
  return points.length ? points : null;
}

/** Split a point into plain text and linked phrases, in order. */
export function linkSegments(point: HighlightPoint): Array<{ text: string; itemId?: number }> {
  const out: Array<{ text: string; itemId?: number }> = [];
  let pos = 0;
  for (const link of point.links) {
    const at = point.text.indexOf(link.text, pos);
    if (at < 0) continue;
    if (at > pos) out.push({ text: point.text.slice(pos, at) });
    out.push({ text: link.text, itemId: link.agenda_item_id });
    pos = at + link.text.length;
  }
  if (pos < point.text.length) out.push({ text: point.text.slice(pos) });
  return out;
}

/** Markdown bullets ("- …"), the stored summary's format, so MeetingSummary renders either. */
export function displaySummary(m: WithSummary | null | undefined): string | null {
  const bullets = meetingHighlights(m);
  if (bullets) return bullets.map((b) => `- ${b}`).join("\n");
  return m?.summary || null;
}
