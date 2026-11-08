import type { ReactNode } from "react";
import { Link } from "react-router";
import { ExternalLink, FileText, Landmark, Lock, MessageSquare, Newspaper } from "lucide-react";
import { Badge } from "../ui/badge";
import { TermText } from "../term";
import { cn, formatDate } from "../../lib/utils";

/**
 * One address, one chronology. Every dated thing the records hold about a lot, in order: each step of each topic
 * at the address (with the pipeline's plain-English headline), the other meeting entries that named it, the City's
 * annual report pages, sources from outside the record (a news release, a news report), and the closed meetings
 * Council held about land the same night. Each row says who said it, so a resident can weigh it.
 */
export type TimelineEntry = {
  key: string;
  date: string;             // YYYY-MM-DD
  kind: "step" | "mention" | "report" | "source" | "closed";
  /** Who said it, as a short label: "Council decision", "Staff report", "Said at the meeting", "City annual report",
   * "Reported by Victoria News", "Closed meeting". */
  label: string;
  headline: string;
  /** Under a written headline: the entry's own title ("Monthly Accounts Payable - January to August 2019"). */
  subline?: string | null;
  detail?: string | null;
  /** The detail is the record's own words (shown as a quote), not a summary. */
  quoted?: boolean;
  href?: string | null;
  external?: boolean;
  /** An archived copy of an outside link (the Wayback Machine), for when the link dies. */
  archiveHref?: string | null;
  /** The outside page's own title, for the link pill. */
  linkTitle?: string | null;
  /** A picture from this step's report (the topic's chosen one), shown beside it. */
  image?: { url: string; alt: string } | null;
  topic?: { slug: string; title: string } | null;
  outcome?: { label: string; variant: "success" | "danger" | "warning" | "muted" } | null;
  /** data-review-entry key, so the review bar can outline the row ("item-12", "matter-5"). */
  reviewKey?: string | null;
};

const ICONS = { step: Landmark, mention: MessageSquare, report: FileText, source: Newspaper, closed: Lock } as const;

/** The small pill the meeting page uses for its document and vote buttons. */
const PILL = "inline-flex items-center gap-1 rounded-full border border-zinc-200 bg-zinc-50 px-2 py-0.5 text-[11px] font-medium text-zinc-600 transition-colors hover:border-brand-200 hover:text-brand-700";

const shortDate = (d: string) => formatDate(d, { year: "numeric", month: "short", day: "numeric" });

export function PropertyTimeline({ entries, newestFirst = true, renderAdmin }: { entries: TimelineEntry[]; newestFirst?: boolean; renderAdmin?: (entry: TimelineEntry) => ReactNode }) {
  const sorted = [...entries].sort((a, b) => (newestFirst ? b.date.localeCompare(a.date) : a.date.localeCompare(b.date)) || a.key.localeCompare(b.key));
  const years = new Map<string, TimelineEntry[]>();
  for (const e of sorted) (years.get(e.date.slice(0, 4)) || years.set(e.date.slice(0, 4), []).get(e.date.slice(0, 4))!).push(e);
  return (
    <div className="space-y-8">
      {[...years.entries()].map(([year, rows]) => (
        <section key={year} aria-label={year}>
          <h3 className="mb-3 text-sm font-semibold tabular-nums text-zinc-500">{year}</h3>
          <ol className="relative space-y-3 before:absolute before:bottom-4 before:left-[5px] before:top-3 before:w-px before:bg-zinc-200">
            {rows.map((e) => <Row key={e.key} entry={e} admin={renderAdmin?.(e)} />)}
          </ol>
        </section>
      ))}
    </div>
  );
}

function Row({ entry: e, admin }: { entry: TimelineEntry; admin?: ReactNode }) {
  const Icon = ICONS[e.kind];
  const strong = e.kind === "step";
  const outside = e.kind === "source" || e.kind === "report";
  const body = (
    <>
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-zinc-500">
        <span className="tabular-nums">{shortDate(e.date)}</span>
        <span className="inline-flex items-center gap-1"><Icon className="h-3.5 w-3.5" aria-hidden="true" />{e.label}</span>
        {e.outcome && <Badge variant={e.outcome.variant}>{e.outcome.label}</Badge>}
      </p>
      <p className={cn("mt-0.5 leading-snug text-zinc-900", strong ? "font-semibold" : "font-medium")}>
        <TermText text={e.headline} />
      </p>
      {e.subline && <p className="mt-0.5 text-xs text-zinc-500">In: {e.subline}</p>}
      {e.detail && (
        outside || e.quoted ? <blockquote className="mt-1 line-clamp-3 text-sm leading-relaxed text-zinc-600">“{e.detail}”</blockquote>
          : <p className="mt-1 line-clamp-2 text-sm leading-relaxed text-zinc-600">{e.detail}</p>
      )}
      {e.topic && (
        <p className="mt-1 text-xs text-zinc-500">Part of <Link to={`/matters/${e.topic.slug}`} className="font-medium text-zinc-700 hover:text-brand-700 hover:underline">{e.topic.title}</Link></p>
      )}
    </>
  );
  const linksBelow = e.external && e.href;
  const card = cn("block rounded-2xl px-5 py-3.5", outside ? "border border-dashed border-zinc-200 bg-surface/70" : "border border-zinc-200 bg-surface shadow-sm",
    e.kind === "closed" && "border-dashed bg-zinc-50", e.href && !linksBelow && "hover:bg-zinc-50");
  const inner = e.image ? (
    <div className="flex gap-4">
      <div className="min-w-0 flex-1">{body}</div>
      <img src={e.image.url} alt={e.image.alt} loading="lazy" className="hidden h-20 w-28 shrink-0 rounded-lg border border-zinc-200 object-cover sm:block" />
    </div>
  ) : body;
  return (
    <li id={`timeline-${e.key}`} className="relative scroll-mt-24 pl-7" {...(e.reviewKey ? { "data-review-entry": e.reviewKey } : {})}>
      <span className={cn("absolute left-0 top-4 h-[11px] w-[11px] rounded-full border-2 border-zinc-50", strong ? "bg-brand-600" : "bg-zinc-300")} />
      {e.href && !linksBelow ? <Link to={e.href} className={card}>{inner}</Link> : (
        <div className={card}>
          {inner}
          {/* An outside page and its archived copy: the same small pills the meeting page uses for its documents. */}
          {linksBelow && (
            <p className="mt-2 flex flex-wrap items-center gap-1.5">
              <a href={e.href!} target="_blank" rel="noopener noreferrer" className={PILL}>
                <ExternalLink className="h-3 w-3" aria-hidden="true" />{e.linkTitle || "Read it"}
              </a>
              {e.archiveHref && (
                <a href={e.archiveHref} target="_blank" rel="noopener noreferrer" className={PILL}>
                  <FileText className="h-3 w-3" aria-hidden="true" />Archived copy
                </a>
              )}
            </p>
          )}
        </div>
      )}
      {admin && <div className="px-5 pt-1 text-xs">{admin}</div>}
    </li>
  );
}
