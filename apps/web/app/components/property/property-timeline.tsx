import type { ReactNode } from "react";
import { Link } from "react-router";
import { ExternalLink, FileText, Table2 } from "lucide-react";
import { Badge } from "../ui/badge";
import { TermText } from "../term";
import { VideoEmbed } from "../video-embed";
import { cn, formatDate } from "../../lib/utils";

/**
 * One address, one chronology. Every dated thing the records hold about a lot, in order: each step of each topic
 * at the address (with the pipeline's plain-English headline), the other meeting entries that named it, the City's
 * annual report pages, sources from outside the record (a news release, a news report), and the closed meetings
 * Council held about land the same night.
 *
 * Two weights. A meeting where Council (or a committee) decided something is a card, with every row from that
 * night inside it; everything else sits as plain text on the rail, so the eye runs decision to decision. The rail
 * disc says what kind of thing each is and, for a decision, how it went.
 */
export type TimelineEntry = {
  key: string;
  date: string;             // YYYY-MM-DD
  kind: "step" | "mention" | "report" | "source" | "closed";
  /** Who said it, for things outside a meeting: "City annual report 2019", "Reported by Victoria News",
   * "Closed meeting". Meeting rows are labelled from ``meeting`` and ``outcome``. */
  label: string;
  headline: string;
  /** Shown instead of the day when the date is approximate ("Spring 2019"); ``date`` still orders the row. */
  dateLabel?: string | null;
  /** Under a written headline: the entry's own title ("Monthly Accounts Payable - January to August 2019"). */
  subline?: string | null;
  detail?: string | null;
  /** The detail is the record's own words (shown as a quote), not a summary. */
  quoted?: boolean;
  href?: string | null;
  external?: boolean;
  /** An archived copy of an outside link (the Wayback Machine), for when the link dies. */
  archiveHref?: string | null;
  /** The label on the link pill ("Victoria News", "Watch on YouTube"); short, since a pill is one line. */
  linkTitle?: string | null;
  /** The page's full title, shown on hover over the pill. */
  linkHint?: string | null;
  /** Pictures kept with a source (the City's FOI table and letter): thumbnails that open full size. */
  images?: { url: string; w: number; h: number; alt: string }[] | null;
  /** A small one-line row on the rail instead of a card (thin context: a notice, an advisory). */
  compact?: boolean;
  /** A YouTube video to embed in the row. */
  video?: { id: string; title: string } | null;
  /** A picture from this step's report (the topic's chosen one), shown beside it. */
  image?: { url: string; alt: string } | null;
  topic?: { slug: string; title: string } | null;
  outcome?: { label: string; variant: "success" | "danger" | "warning" | "muted" } | null;
  /** The meeting a step or mention belongs to; rows from one meeting fold into one card. */
  meeting?: { id: number; title: string | null; href: string; committee: boolean } | null;
  /** data-review-entry key, so the review bar can outline the row ("item-12", "matter-5"). */
  reviewKey?: string | null;
};

/** The small pill the meeting page uses for its document and vote buttons. */
const PILL = "inline-flex items-center gap-1 rounded-full border border-zinc-200 bg-zinc-50 px-2 py-0.5 text-[11px] font-medium text-zinc-600 transition-colors hover:border-brand-200 hover:text-brand-700";

/** A quote set as a pull quote: italic, a thin brand-tinted rule, a touch darker than body text. Not loud. */
export const PULL = "border-l-2 border-brand-200 pl-3 italic text-zinc-700";

const shortDate = (d: string) => formatDate(d, { year: "numeric", month: "short", day: "numeric" });

/** Everything that was not a decision: a faded card, same shape and padding as a decided meeting's, no shadow. */
const FADED = "rounded-2xl border border-zinc-200/80 bg-surface/60 px-5 py-3.5";

/** Exported for tests: a quote that is a table or a register, not prose (a cheque list, a budget schedule). */
export function looksTabular(text: string): boolean {
  const tokens = text.trim().split(/\s+/);
  if (tokens.length < 8) return false;
  const numeric = tokens.filter((t) => /\d/.test(t)).length;
  const sentences = (text.match(/[a-z]{3,}[.!?](\s|$)/g) || []).length;
  return numeric / tokens.length >= 0.3 && sentences <= 1;
}

export type Group = { key: string; date: string; kind: TimelineEntry["kind"] | "meeting"; entries: TimelineEntry[]; decided: boolean; meeting?: TimelineEntry["meeting"] };

const rank = (e: TimelineEntry) => (e.kind === "closed" ? 2 : e.outcome ? 0 : 1);

/** Rows from the same meeting fold into one group; everything else stands alone. Exported for tests. */
export function groupEntries(entries: TimelineEntry[], newestFirst = true): Group[] {
  const sorted = [...entries].sort((a, b) => (newestFirst ? b.date.localeCompare(a.date) : a.date.localeCompare(b.date)) || a.key.localeCompare(b.key));
  const groups: Group[] = [];
  const byMeeting = new Map<number, Group>();
  for (const e of sorted) {
    if (e.meeting && (e.kind === "step" || e.kind === "mention" || e.kind === "closed")) {
      let g = byMeeting.get(e.meeting.id);
      if (!g) {
        g = { key: `meeting-${e.meeting.id}`, date: e.date, kind: "meeting", entries: [], decided: false, meeting: e.meeting };
        byMeeting.set(e.meeting.id, g);
        groups.push(g);
      }
      g.entries.push(e);
      if (e.outcome) g.decided = true;
    } else {
      groups.push({ key: e.key, date: e.date, kind: e.kind, entries: [e], decided: false });
    }
  }
  // Inside a meeting: decisions first, then discussion, the closed-doors note last.
  for (const g of groups) if (g.kind === "meeting") g.entries.sort((a, b) => rank(a) - rank(b));
  return groups;
}

export function PropertyTimeline({ entries, newestFirst = true, renderAdmin }: { entries: TimelineEntry[]; newestFirst?: boolean; renderAdmin?: (entry: TimelineEntry) => ReactNode }) {
  const groups = groupEntries(entries, newestFirst);
  const years = new Map<string, Group[]>();
  for (const g of groups) (years.get(g.date.slice(0, 4)) || years.set(g.date.slice(0, 4), []).get(g.date.slice(0, 4))!).push(g);
  return (
    // One rail runs the whole length, through the year labels, and fades out below the last card instead of stopping.
    // On wide screens it hangs in the left margin (the rows indent by 2.5rem and the list pulls back by as much), so
    // the cards share the page's left edge with every other card; on a phone the rows indent instead.
    <div className="relative">
      <span aria-hidden="true" className="absolute -bottom-12 left-[11px] top-3 w-px md:-left-[29px]"
        style={{ background: "linear-gradient(to bottom, var(--color-zinc-200) calc(100% - 5rem), transparent)" }} />
      <div className="space-y-8">
        {[...years.entries()].map(([year, rows]) => (
          <section key={year} aria-label={year} className="relative">
            <h3 className="mb-4 pl-10 text-lg font-semibold tabular-nums tracking-tight text-zinc-500 md:pl-0">{year}</h3>
            <ol className="relative space-y-5 md:-ml-10">
              {rows.map((g) => <GroupRow key={g.key} group={g} renderAdmin={renderAdmin} />)}
            </ol>
          </section>
        ))}
      </div>
    </div>
  );
}

/** The rail dot: filled, in the outcome's colour, where something was decided; hollow for everything else. */
function Disc({ group }: { group: Group }) {
  const outcome = group.entries.find((e) => e.outcome)?.outcome;
  const tone = outcome?.variant === "success" ? "border-emerald-600 bg-emerald-600"
    : outcome?.variant === "danger" ? "border-red-600 bg-red-600"
    : outcome?.variant === "warning" ? "border-amber-500 bg-amber-500"
    : group.decided ? "border-brand-600 bg-brand-600"
    : "border-zinc-300 bg-surface";
  return <span className={cn("absolute left-[6px] top-[18px] h-3 w-3 rounded-full border-2", tone)} aria-hidden="true" />;
}

function GroupRow({ group: g, renderAdmin }: { group: Group; renderAdmin?: (entry: TimelineEntry) => ReactNode }) {
  if (g.kind === "meeting") return <MeetingRow group={g} renderAdmin={renderAdmin} />;
  const e = g.entries[0];
  if (e.compact) {
    return (
      <li id={`timeline-${e.key}`} className="relative scroll-mt-24 pl-10" {...(e.reviewKey ? { "data-review-entry": e.reviewKey } : {})}>
        <span aria-hidden="true" className="absolute left-[8px] top-[7px] h-2 w-2 rounded-full border border-zinc-300 bg-surface" />
        <p className="text-xs leading-relaxed text-zinc-500">
          <span className="tabular-nums text-zinc-600">{e.dateLabel || shortDate(e.date)}</span> · {e.label} · {e.headline}
          {e.external && e.href && <> · <a href={e.href} target="_blank" rel="noopener noreferrer" title={e.linkHint || undefined} className="underline decoration-zinc-300 underline-offset-2 hover:text-brand-700">{e.linkTitle || "Source"}</a></>}
        </p>
        {renderAdmin?.(e) && <div className="pt-1 text-xs">{renderAdmin(e)}</div>}
      </li>
    );
  }
  return (
    <li id={`timeline-${e.key}`} className="relative scroll-mt-24 pl-10" {...(e.reviewKey ? { "data-review-entry": e.reviewKey } : {})}>
      <Disc group={g} />
      <div className={FADED}>
      <p className="text-xs text-zinc-500"><span className="tabular-nums">{e.dateLabel || shortDate(e.date)}</span> · {e.label}</p>
      {e.kind === "report"
        ? <blockquote className={cn("mt-1.5 text-[0.95rem] leading-relaxed", PULL)}>“{e.headline}”</blockquote>
        : <p className="mt-0.5 font-medium leading-snug text-zinc-800"><TermText text={e.headline} /></p>}
      {e.kind === "closed" ? (e.detail && <p className="mt-1 line-clamp-2 text-sm leading-relaxed text-zinc-600">{e.detail}</p>) : <Detail entry={e} />}
      {e.video && <VideoEmbed id={e.video.id} title={e.video.title} className="mt-2" />}
      {!!e.images?.length && (
        <div className="mt-2.5">
          <div className="flex flex-wrap items-start gap-2.5">
            {e.images.map((im) => (
              <a key={im.url} href={im.url} target="_blank" rel="noopener noreferrer" title="Open full size"
                className="block overflow-hidden rounded-lg border border-zinc-200 bg-white shadow-sm transition-shadow hover:shadow-md">
                <img src={im.url} alt={im.alt} width={im.w} height={im.h} loading="lazy" className="h-44 w-auto max-w-full object-contain" />
              </a>
            ))}
          </div>
          <p className="mt-1 text-xs text-zinc-500">As posted with the City's response. Click to enlarge.</p>
        </div>
      )}
      {e.external && e.href && (
        <p className="mt-2 flex flex-wrap items-center gap-1.5">
          <a href={e.href} target="_blank" rel="noopener noreferrer" title={e.linkHint || undefined} className={cn(PILL, "max-w-full whitespace-nowrap")}><ExternalLink className="h-3 w-3 shrink-0" aria-hidden="true" /><span className="truncate">{e.linkTitle || "Read it"}</span></a>
          {e.archiveHref && <a href={e.archiveHref} target="_blank" rel="noopener noreferrer" className={cn(PILL, "whitespace-nowrap")}><FileText className="h-3 w-3 shrink-0" aria-hidden="true" />Archived copy</a>}
        </p>
      )}
      {renderAdmin?.(e) && <div className="pt-1 text-xs">{renderAdmin(e)}</div>}
      </div>
    </li>
  );
}

/** One night at Council: a card when something was decided, plain rows when it was only discussed. */
function MeetingRow({ group: g, renderAdmin }: { group: Group; renderAdmin?: (entry: TimelineEntry) => ReactNode }) {
  const m = g.meeting!;
  const image = g.entries.find((e) => e.image)?.image;
  const decisions = g.entries.filter((e) => e.outcome).length;
  const head = g.decided ? (
    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-b border-zinc-100 px-5 pb-2.5 pt-3.5 text-xs">
      <p className="text-zinc-600">
        <span className="font-semibold tabular-nums text-zinc-800">{shortDate(g.date)}</span>
        {m.title && <> · <Link to={m.href} className="hover:text-brand-700 hover:underline">{m.title}</Link></>}
      </p>
      <p className="text-zinc-500">{decisions === 1 ? "1 decision" : `${decisions} decisions`}</p>
    </div>
  ) : (
    // The header carries the verb once: "Sep 24, 2020 · Parks … Committee Discussed".
    <p className="text-xs text-zinc-500">
      <span className="font-semibold tabular-nums text-zinc-700">{shortDate(g.date)}</span>
      {m.title && <> · <Link to={m.href} className="hover:text-brand-700 hover:underline">{m.title}</Link></>} Discussed
    </p>
  );
  const rows = (
    <ul className={cn(g.decided ? "divide-y divide-zinc-100 px-5" : "mt-1.5 space-y-3")}>
      {g.entries.map((e) => (
        <li key={e.key} id={`timeline-${e.key}`} className={cn("scroll-mt-24", g.decided && "py-3")} {...(e.reviewKey ? { "data-review-entry": e.reviewKey } : {})}>
          {/* No verb line when the header already says it. In a decision card a row shows its outcome or "Discussed";
              a closed-meeting row keeps its own label. */}
          {(g.decided || e.kind === "closed") && (
            <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-zinc-500">
              {e.outcome ? <Badge variant={e.outcome.variant}>{e.outcome.label}</Badge> : <span>{e.kind === "closed" ? "Closed meeting" : "Discussed"}</span>}
            </p>
          )}
          <p className={cn("mt-0.5 leading-snug text-zinc-900", e.outcome ? "font-semibold" : "font-medium")}>
            {e.href && e.kind !== "closed" ? <Link to={e.href} className="hover:text-brand-700"><TermText text={e.headline} /></Link> : <TermText text={e.headline} />}
          </p>
          {e.subline && <p className="mt-0.5 text-xs text-zinc-500">In: {e.subline}</p>}
          {e.kind === "closed" ? (e.detail && <p className="mt-1 line-clamp-2 text-sm leading-relaxed text-zinc-600">{e.detail}</p>) : <Detail entry={e} />}
          {e.topic && <p className="mt-1 text-xs text-zinc-500">Part of <Link to={`/matters/${e.topic.slug}`} className="font-medium text-zinc-700 hover:text-brand-700 hover:underline">{e.topic.title}</Link></p>}
          {renderAdmin?.(e) && <div className="pt-1 text-xs">{renderAdmin(e)}</div>}
        </li>
      ))}
    </ul>
  );
  return (
    <li id={`timeline-${g.key}`} className="relative scroll-mt-24 pl-10">
      <Disc group={g} />
      {g.decided ? (
        <div className="overflow-hidden rounded-2xl border border-zinc-200 bg-surface shadow-sm">
          {head}
          {image ? (
            <div className="flex gap-4 pr-5">
              <div className="min-w-0 flex-1">{rows}</div>
              <img src={image.url} alt={image.alt} loading="lazy" className="mt-3 hidden h-24 w-32 shrink-0 rounded-lg border border-zinc-200 object-cover sm:block" />
            </div>
          ) : rows}
        </div>
      ) : <div className={FADED}>{head}{rows}</div>}
    </li>
  );
}

/** A quote or summary under a row: prose is clamped to two lines; a table or register hides behind a pill. */
function Detail({ entry: e }: { entry: TimelineEntry }) {
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
    ? <blockquote className={cn("mt-2 line-clamp-6 text-[0.95rem] leading-relaxed", PULL)}>“{e.detail}”</blockquote>
    : <p className="mt-1 line-clamp-2 text-sm leading-relaxed text-zinc-600">{e.detail}</p>;
}
