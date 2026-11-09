import type { ReactNode } from "react";
import { Link } from "react-router";
import { Badge } from "../ui/badge";
import { TermText } from "../term";
import { cn } from "../../lib/utils";
import type { TimelineEntry } from "../../lib/timeline-entry";
import { DECIDED_CARD, Disc, FADED_CARD, RailItem, YearTimeline, shortDate } from "../timeline/chrome";
import { Detail, EntryRow, looksTabular } from "../timeline/entry-rows";

/**
 * One address, one chronology. Every dated thing the records hold about a lot, in order: each step of each topic
 * at the address (with the pipeline's plain-English headline), the other meeting entries that named it, the City's
 * annual report pages, sources from outside the record (a news release, a news report), and the closed meetings
 * Council held about land the same night.
 *
 * Two weights. A meeting where Council (or a committee) decided something is a card, with every row from that
 * night inside it; everything else sits as a faded card on the rail, so the eye runs decision to decision. The rail
 * disc says what kind of thing each is and, for a decision, how it went. The frame (rail, years, dots, cards) and the
 * rows a source, a report or a closed meeting is drawn with are shared with the topic page: components/timeline/.
 */
export type { TimelineEntry };
export { looksTabular };

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
  return (
    <YearTimeline rows={groupEntries(entries, newestFirst)} dateOf={(g) => g.date}>
      {(g) => <GroupRow key={g.key} group={g} renderAdmin={renderAdmin} />}
    </YearTimeline>
  );
}

function GroupRow({ group: g, renderAdmin }: { group: Group; renderAdmin?: (entry: TimelineEntry) => ReactNode }) {
  if (g.kind === "meeting") return <MeetingRow group={g} renderAdmin={renderAdmin} />;
  return <EntryRow entry={g.entries[0]} renderAdmin={renderAdmin} />;
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
    <RailItem id={g.key} dot={<Disc outcome={g.entries.find((e) => e.outcome)?.outcome} decided={g.decided} />}>
      {g.decided ? (
        <div className={DECIDED_CARD}>
          {head}
          {image ? (
            <div className="flex gap-4 pr-5">
              <div className="min-w-0 flex-1">{rows}</div>
              <img src={image.url} alt={image.alt} loading="lazy" className="mt-3 hidden h-24 w-32 shrink-0 rounded-lg border border-zinc-200 object-cover sm:block" />
            </div>
          ) : rows}
        </div>
      ) : <div className={FADED_CARD}>{head}{rows}</div>}
    </RailItem>
  );
}
