import type { ReactNode } from "react";
import { ExternalLink, FileText, Table2 } from "lucide-react";
import { TermText } from "../term";
import { VideoEmbed } from "../video-embed";
import { PullQuote } from "../pull-quote";
import { cn } from "../../lib/utils";
import type { TimelineEntry } from "../../lib/timeline-entry";
import { Disc, FADED_CARD, PILL, RailItem, shortDate } from "./chrome";

/**
 * The rows both timelines draw the same way: a source from outside the record, an annual report page, a closed
 * meeting. `EntryRow` is a faded card with its quote, video, pictures and link pills, or, for thin context, a
 * one-line note.
 */

/** Exported for tests: a quote that is a table or a register, not prose (a cheque list, a budget schedule). */
export function looksTabular(text: string): boolean {
  const tokens = text.trim().split(/\s+/);
  if (tokens.length < 8) return false;
  const numeric = tokens.filter((t) => /\d/.test(t)).length;
  const sentences = (text.match(/[a-z]{3,}[.!?](\s|$)/g) || []).length;
  return numeric / tokens.length >= 0.3 && sentences <= 1;
}

/** A quote or summary under a row: prose is clamped to two lines; a table or register hides behind a pill. */
export function Detail({ entry: e }: { entry: TimelineEntry }) {
  if (!e.detail) return null;
  if (e.quoted && looksTabular(e.detail)) {
    return (
      <details className="mt-1.5 text-xs">
        <summary className={cn(PILL, "cursor-pointer list-none")}><Table2 className="h-3 w-3" aria-hidden="true" />From the table</summary>
        <blockquote className="mt-2 rounded-lg bg-zinc-50 px-3 py-2 font-mono text-[11px] leading-relaxed text-zinc-600">{e.detail}</blockquote>
      </details>
    );
  }
  // A quote is the evidence, so it gets room (about six lines); a summary is only a pointer, so it stays short.
  return e.quoted || e.kind === "source" || e.kind === "report"
    ? <PullQuote className="mt-2">“{e.detail}”</PullQuote>
    : <p className="mt-1 line-clamp-2 text-sm leading-relaxed text-zinc-600">{e.detail}</p>;
}

/** Pictures kept with a source: thumbnails that open full size, or the PDF they preview (marked PDF). */
export function EntryImages({ images }: { images: NonNullable<TimelineEntry["images"]> }) {
  const caption = images.find((im) => im.caption)?.caption
    || (images.some((im) => im.pdf) ? "As released by the City. Click to open the PDF." : "As posted with the City's response. Click to enlarge.");
  return (
    <div className="mt-2.5">
      <div className="flex flex-wrap items-start gap-2.5">
        {images.map((im) => (
          <a key={im.url} href={im.href} target="_blank" rel="noopener noreferrer" title={im.pdf ? "Open the PDF" : "Open full size"}
            className="relative block overflow-hidden rounded-lg border border-zinc-200 bg-white shadow-sm transition-shadow hover:shadow-md">
            <img src={im.url} alt={im.alt} width={im.w} height={im.h} loading="lazy" className="h-44 w-auto max-w-full object-contain" />
            {im.pdf && <span className="absolute bottom-1.5 right-1.5 rounded bg-black/75 px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-white">PDF</span>}
          </a>
        ))}
      </div>
      <p className="mt-1 text-xs text-zinc-500">{caption}</p>
    </div>
  );
}

/** The link to where a statement came from, and its archived copy for when the link dies. */
export function EntryLinks({ entry: e }: { entry: TimelineEntry }) {
  if (!(e.external && e.href)) return null;
  return (
    <p className="mt-2 flex flex-wrap items-center gap-1.5">
      <a href={e.href} target="_blank" rel="noopener noreferrer" title={e.linkHint || undefined} className={cn(PILL, "max-w-full whitespace-nowrap")}>
        <ExternalLink className="h-3 w-3 shrink-0" aria-hidden="true" /><span className="truncate">{e.linkTitle || "Read it"}</span>
      </a>
      {e.archiveHref && <a href={e.archiveHref} target="_blank" rel="noopener noreferrer" className={cn(PILL, "whitespace-nowrap")}><FileText className="h-3 w-3 shrink-0" aria-hidden="true" />Archived copy</a>}
    </p>
  );
}

/** A row that stands alone on the rail: a source, an annual report page, or a closed meeting. */
export function EntryRow({ entry: e, renderAdmin }: { entry: TimelineEntry; renderAdmin?: (entry: TimelineEntry) => ReactNode }) {
  if (e.compact) {
    return (
      <RailItem id={e.key} reviewKey={e.reviewKey}
        dot={<span aria-hidden="true" className="absolute left-[8px] top-[7px] h-2 w-2 rounded-full border border-zinc-300 bg-surface" />}>
        {/* One wrapper, so the review bar has something to outline (it outlines a row's first <div>). */}
        <div>
          <p className="text-xs leading-relaxed text-zinc-500">
            <span className="tabular-nums text-zinc-600">{e.dateLabel || shortDate(e.date)}</span> · {e.label} · {e.headline}
            {e.external && e.href && <> · <a href={e.href} target="_blank" rel="noopener noreferrer" title={e.linkHint || undefined} className="underline decoration-zinc-300 underline-offset-2 hover:text-brand-700">{e.linkTitle || "Source"}</a></>}
          </p>
          {renderAdmin?.(e) && <div className="pt-1 text-xs">{renderAdmin(e)}</div>}
        </div>
      </RailItem>
    );
  }
  // A report's headline is the page's own words (shown as a quote) unless staff wrote the line (quoted: false).
  const asQuote = e.kind === "report" && e.quoted !== false;
  return (
    <RailItem id={e.key} reviewKey={e.reviewKey} dot={<Disc />}>
      <div className={FADED_CARD}>
        <p className="text-xs text-zinc-500"><span className="tabular-nums">{e.dateLabel || shortDate(e.date)}</span> · {e.label}</p>
        {e.lead && <p className="mt-0.5 text-sm font-medium text-zinc-700">{e.lead}</p>}
        {asQuote
          ? <PullQuote className="mt-1.5">“{e.headline}”</PullQuote>
          : <p className="mt-0.5 font-medium leading-snug text-zinc-800"><TermText text={e.headline} /></p>}
        {e.kind === "closed" ? (e.detail && <p className="mt-1 line-clamp-2 text-sm leading-relaxed text-zinc-600">{e.detail}</p>) : <Detail entry={e} />}
        {e.video && <VideoEmbed id={e.video.id} title={e.video.title} className="mt-2" />}
        {!!e.images?.length && <EntryImages images={e.images} />}
        <EntryLinks entry={e} />
        {renderAdmin?.(e) && <div className="pt-1 text-xs">{renderAdmin(e)}</div>}
      </div>
    </RailItem>
  );
}

