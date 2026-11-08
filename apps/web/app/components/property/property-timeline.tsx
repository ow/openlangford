import type { ReactNode } from "react";
import { Link } from "react-router";
import { ExternalLink, FileText, Landmark, Lock, Newspaper, Table2 } from "lucide-react";
import { Badge } from "../ui/badge";
import { TermText } from "../term";
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
  /** The meeting a step or mention belongs to; rows from one meeting fold into one card. */
  meeting?: { id: number; title: string | null; href: string; committee: boolean } | null;
  /** data-review-entry key, so the review bar can outline the row ("item-12", "matter-5"). */
  reviewKey?: string | null;
};

/** The small pill the meeting page uses for its document and vote buttons. */
const PILL = "inline-flex items-center gap-1 rounded-full border border-zinc-200 bg-zinc-50 px-2 py-0.5 text-[11px] font-medium text-zinc-600 transition-colors hover:border-brand-200 hover:text-brand-700";

const shortDate = (d: string) => formatDate(d, { year: "numeric", month: "short", day: "numeric" });

/** Exported for tests: a quote that is a table or a register, not prose (a cheque list, a budget schedule). */
export function looksTabular(text: string): boolean {
  const tokens = text.trim().split(/\s+/);
  if (tokens.length < 8) return false;
  const numeric = tokens.filter((t) => /\d/.test(t)).length;
  const sentences = (text.match(/[a-z]{3,}[.!?](\s|$)/g) || []).length;
  return numeric / tokens.length >= 0.3 && sentences <= 1;
}

/** "Council decided", "Committee discussed": what a meeting row is, in the one vocabulary the page uses. */
function meetingLabel(e: TimelineEntry): string {
  const who = e.meeting?.committee ? "Committee" : "Council";
  return `${who} ${e.outcome ? "decided" : "discussed"}`;
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
    <div className="space-y-10">
      {[...years.entries()].map(([year, rows]) => (
        <section key={year} aria-label={year} className="relative">
          <h3 className="mb-4 flex items-center gap-3 text-lg font-semibold tabular-nums tracking-tight text-zinc-500">
            {year}<span aria-hidden="true" className="h-px flex-1 bg-zinc-200" />
          </h3>
          <ol className="relative space-y-5 before:absolute before:bottom-2 before:left-[11px] before:top-2 before:w-px before:bg-zinc-200">
            {rows.map((g) => <GroupRow key={g.key} group={g} renderAdmin={renderAdmin} />)}
          </ol>
        </section>
      ))}
    </div>
  );
}

/** The rail disc: what kind of thing this is and, for a decision, how it went. */
function Disc({ group }: { group: Group }) {
  const outcome = group.entries.find((e) => e.outcome)?.outcome;
  const Icon = group.kind === "source" ? Newspaper : group.kind === "report" ? FileText : group.kind === "closed" ? Lock : Landmark;
  const tone = outcome?.variant === "success" ? "border-emerald-600 bg-emerald-600 text-white"
    : outcome?.variant === "danger" ? "border-red-600 bg-red-600 text-white"
    : outcome?.variant === "warning" ? "border-amber-500 bg-amber-500 text-white"
    : group.decided ? "border-brand-600 bg-brand-600 text-white"
    : "border-zinc-200 bg-surface text-zinc-400";
  return (
    <span className={cn("absolute left-0 top-0.5 flex h-6 w-6 items-center justify-center rounded-full border", tone)} aria-hidden="true">
      <Icon className="h-3 w-3" />
    </span>
  );
}

function GroupRow({ group: g, renderAdmin }: { group: Group; renderAdmin?: (entry: TimelineEntry) => ReactNode }) {
  if (g.kind === "meeting") return <MeetingRow group={g} renderAdmin={renderAdmin} />;
  const e = g.entries[0];
  return (
    <li id={`timeline-${e.key}`} className="relative scroll-mt-24 pl-10" {...(e.reviewKey ? { "data-review-entry": e.reviewKey } : {})}>
      <Disc group={g} />
      <p className="text-xs text-zinc-500"><span className="tabular-nums">{shortDate(e.date)}</span> · {e.label}</p>
      <p className="mt-0.5 font-medium leading-snug text-zinc-800"><TermText text={e.headline} /></p>
      {e.kind === "closed" && e.detail && <p className="mt-1 text-sm leading-relaxed text-zinc-500">{e.detail}</p>}
      {e.kind !== "closed" && <Detail entry={e} />}
      {e.external && e.href && (
        <p className="mt-2 flex flex-wrap items-center gap-1.5">
          <a href={e.href} target="_blank" rel="noopener noreferrer" className={PILL}><ExternalLink className="h-3 w-3" aria-hidden="true" />{e.linkTitle || "Read it"}</a>
          {e.archiveHref && <a href={e.archiveHref} target="_blank" rel="noopener noreferrer" className={PILL}><FileText className="h-3 w-3" aria-hidden="true" />Archived copy</a>}
        </p>
      )}
      {!e.external && e.href && e.kind === "closed" && <Link to={e.href} className="mt-1 inline-block text-xs text-zinc-500 hover:text-brand-700 hover:underline">The meeting</Link>}
      {renderAdmin?.(e) && <div className="pt-1 text-xs">{renderAdmin(e)}</div>}
    </li>
  );
}

/** One night at Council: a card when something was decided, plain rows when it was only discussed. */
function MeetingRow({ group: g, renderAdmin }: { group: Group; renderAdmin?: (entry: TimelineEntry) => ReactNode }) {
  const m = g.meeting!;
  const image = g.entries.find((e) => e.image)?.image;
  const decisions = g.entries.filter((e) => e.outcome).length;
  const head = g.decided ? (
    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-b border-zinc-100 bg-zinc-50/70 px-5 py-2.5 text-xs">
      <p className="text-zinc-600">
        <span className="font-semibold tabular-nums text-zinc-800">{shortDate(g.date)}</span>
        {m.title && <> · <Link to={m.href} className="hover:text-brand-700 hover:underline">{m.title}</Link></>}
      </p>
      <p className="text-zinc-500">{decisions === 1 ? "1 decision" : `${decisions} decisions`}</p>
    </div>
  ) : (
    <p className="text-xs text-zinc-500">
      <span className="tabular-nums">{shortDate(g.date)}</span>
      {m.title && <> · <Link to={m.href} className="hover:text-brand-700 hover:underline">{m.title}</Link></>}
    </p>
  );
  const rows = (
    <ul className={cn(g.decided ? "divide-y divide-zinc-100 px-5" : "mt-1.5 space-y-3")}>
      {g.entries.map((e) => (
        <li key={e.key} id={`timeline-${e.key}`} className={cn("scroll-mt-24", g.decided && "py-3")} {...(e.reviewKey ? { "data-review-entry": e.reviewKey } : {})}>
          {e.kind === "closed" ? (
            <p className="flex items-start gap-1.5 text-xs text-zinc-500"><Lock className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" /><span>{e.headline}. {e.detail}</span></p>
          ) : (
            <>
              <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-zinc-500">
                <span>{meetingLabel(e)}</span>
                {e.outcome && <Badge variant={e.outcome.variant}>{e.outcome.label}</Badge>}
              </p>
              <p className={cn("mt-0.5 leading-snug text-zinc-900", e.outcome ? "font-semibold" : "font-medium")}>
                {e.href ? <Link to={e.href} className="hover:text-brand-700"><TermText text={e.headline} /></Link> : <TermText text={e.headline} />}
              </p>
              {e.subline && <p className="mt-0.5 text-xs text-zinc-500">In: {e.subline}</p>}
              <Detail entry={e} />
              {e.topic && <p className="mt-1 text-xs text-zinc-500">Part of <Link to={`/matters/${e.topic.slug}`} className="font-medium text-zinc-700 hover:text-brand-700 hover:underline">{e.topic.title}</Link></p>}
              {renderAdmin?.(e) && <div className="pt-1 text-xs">{renderAdmin(e)}</div>}
            </>
          )}
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
      ) : <>{head}{rows}</>}
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
  return e.quoted || e.kind === "source" || e.kind === "report"
    ? <blockquote className="mt-1 line-clamp-2 text-sm leading-relaxed text-zinc-600">“{e.detail}”</blockquote>
    : <p className="mt-1 line-clamp-2 text-sm leading-relaxed text-zinc-600">{e.detail}</p>;
}
