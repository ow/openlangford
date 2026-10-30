import type { ReactNode } from "react";
import { Link } from "react-router";
import { cn } from "../../lib/utils";
import { linkSegments, type HighlightPoint } from "../../lib/meeting-summary";

/**
 * Summaries are stored as Markdown bullets ("- …") by the pipeline. Return
 * the bullet texts as-is; anything else is a single paragraph.
 */
export function summaryPoints(summary: string): string[] {
  const lines = summary
    .split(/\n+/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length > 0 && lines.every((l) => /^[-*•]\s+/.test(l))) {
    return lines.map((l) => l.replace(/^[-*•]\s+/, ""));
  }
  return [summary.trim()].filter(Boolean);
}

/** Where a linked phrase goes: "#item-12" on the meeting page, "/meetings/slug#item-12" elsewhere. */
export type ItemHref = (agendaItemId: number) => string | null;

interface MeetingSummaryProps {
  summary: string;
  /** Plain-language highlights with agenda-item links (lib/meeting-summary.ts). Used instead of `summary` when given. */
  points?: HighlightPoint[] | null;
  /** Turns an agenda item id into a link target; without it, phrases render as plain text. */
  itemHref?: ItemHref;
  /** Show at most this many points (home cards, previews). */
  limit?: number;
  className?: string;
}

export const highlightLinkClass =
  "relative z-10 rounded-sm text-inherit underline decoration-brand-300 decoration-1 underline-offset-[3px] transition-colors hover:text-brand-800 hover:decoration-brand-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600";

/** One point, with its linked phrases as links when there is somewhere to go. */
export function LinkedPoint({ point, itemHref }: { point: HighlightPoint; itemHref?: ItemHref }): ReactNode {
  if (!itemHref || point.links.length === 0) return point.text;
  return linkSegments(point).map((seg, i) => {
    const href = seg.itemId != null ? itemHref(seg.itemId) : null;
    if (!href) return <span key={i}>{seg.text}</span>;
    // Same-page anchors stay plain <a> so the browser updates the hash (the meeting page opens and scrolls to the item).
    return href.startsWith("#") ? (
      <a key={i} href={href} className={highlightLinkClass}>
        {seg.text}
      </a>
    ) : (
      <Link key={i} to={href} className={highlightLinkClass}>
        {seg.text}
      </Link>
    );
  });
}

/** Meeting summary as a short, scannable bullet list. */
export function MeetingSummary({ summary, points, itemHref, limit, className }: MeetingSummaryProps) {
  const all: HighlightPoint[] = points?.length ? points : summaryPoints(summary).map((text) => ({ text, links: [] }));
  const shown = limit ? all.slice(0, limit) : all;
  if (shown.length === 0) return null;

  if (shown.length === 1) {
    return (
      <p className={cn("leading-relaxed text-zinc-700", className)}>
        <LinkedPoint point={shown[0]} itemHref={itemHref} />
      </p>
    );
  }

  return (
    <ul className={cn("space-y-2 text-zinc-700", className)}>
      {shown.map((point, i) => (
        <li key={i} className="flex gap-3 leading-relaxed">
          <span className="mt-[0.6em] h-1.5 w-1.5 shrink-0 rounded-full bg-brand-500" aria-hidden="true" />
          <span>
            <LinkedPoint point={point} itemHref={itemHref} />
          </span>
        </li>
      ))}
    </ul>
  );
}
