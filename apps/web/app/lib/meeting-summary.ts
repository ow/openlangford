/**
 * What a meeting page, card or the home page shows as the meeting's summary: the plain-language
 * highlights from the pipeline's meeting-highlights stage (meetings.meta.highlights.bullets,
 * written to docs/writing-style.md) when the meeting has them, else the original summary.
 * Loaders select `highlights:meta->highlights` (never the whole meta, which holds private data);
 * the detail pages pass `meta.highlights` through their allowlist.
 */
type WithSummary = { summary?: string | null; highlights?: any; meta?: { highlights?: any } | null };

export function meetingHighlights(m: WithSummary | null | undefined): string[] | null {
  const highlights = m?.highlights ?? m?.meta?.highlights;
  const bullets = Array.isArray(highlights?.bullets)
    ? highlights.bullets.filter((b: unknown): b is string => typeof b === "string" && b.trim() !== "").map((b: string) => b.trim())
    : [];
  return bullets.length ? bullets : null;
}

/** Markdown bullets ("- …"), the stored summary's format, so MeetingSummary renders either. */
export function displaySummary(m: WithSummary | null | undefined): string | null {
  const bullets = meetingHighlights(m);
  if (bullets) return bullets.map((b) => `- ${b}`).join("\n");
  return m?.summary || null;
}
