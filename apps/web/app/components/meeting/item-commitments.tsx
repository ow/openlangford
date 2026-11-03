import { useState } from "react";
import { ChevronDown, Flag, PlayCircle } from "lucide-react";
import { cn } from "../../lib/utils";
import { formatTimestamp } from "../../lib/timeline-utils";

type Commitment = {
  group?: string;
  text: string;
  /** A short label for the few pledges shown first (headline tiles, the home card). */
  short?: string;
  key?: boolean;
  quotes?: string[];
  start_time?: number | null;
};
export type ItemCommitments = { title?: string; note?: string; items?: Commitment[] };

/** The first agenda item carrying pledges from a speech (agenda_items.meta.commitments), for the meeting-level section. */
export function meetingCommitments(items: { id: number; title?: string | null; meta?: any }[]) {
  const item = items.find((it) => (it.meta?.commitments?.items?.length ?? 0) > 0);
  return item ? { itemId: item.id, itemTitle: item.title ?? "", commitments: item.meta.commitments as ItemCommitments } : null;
}

/** The pledges marked as headline ones, in speech order. */
export function keyCommitments(items: Commitment[] = []) {
  return items.filter((item) => item.key).sort((a, b) => (a.start_time ?? 0) - (b.start_time ?? 0));
}

function grouped(items: Commitment[]) {
  const groups: { name: string; items: Commitment[] }[] = [];
  for (const item of items) {
    const name = item.group ?? "";
    const group = groups.find((g) => g.name === name) ?? groups[groups.push({ name, items: [] }) - 1];
    group.items.push(item);
  }
  return groups;
}

function TimeButton({ time, onWatchVideo }: { time?: number | null; onWatchVideo?: (startTime: number) => void }) {
  if (time == null || !onWatchVideo) return null;
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onWatchVideo(time);
      }}
      className="shrink-0 rounded-md px-1.5 py-0.5 font-mono text-xs text-brand-600 tabular-nums hover:bg-brand-100 hover:text-brand-700"
      aria-label={`Watch at ${formatTimestamp(time)}`}
    >
      {formatTimestamp(time)}
    </button>
  );
}

function QuotesToggle({ showQuotes, onToggle }: { showQuotes: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      className="shrink-0 text-xs font-medium text-brand-600 hover:text-brand-700"
    >
      {showQuotes ? "Hide his words" : "Show his words"}
    </button>
  );
}

/** Every pledge, one theme per row: the theme on the left (above on narrow screens), pledges with their times on the right. */
function CommitmentGroups({
  items,
  showQuotes,
  onWatchVideo,
}: {
  items: Commitment[];
  showQuotes: boolean;
  onWatchVideo?: (startTime: number) => void;
}) {
  return (
    <div className="divide-y divide-zinc-200/70">
      {grouped(items).map((group) => (
        <div key={group.name} className="grid gap-x-6 gap-y-1.5 py-3 first:pt-0 last:pb-0 sm:grid-cols-[9.5rem_1fr]">
          <p className="pt-0.5 text-xs font-semibold text-zinc-700">{group.name}</p>
          <ul className="space-y-1.5">
            {group.items.map((item, i) => (
              <li key={i} className="flex items-start justify-between gap-3 text-sm leading-relaxed text-zinc-800">
                <div className="min-w-0">
                  <p>{item.text}</p>
                  {showQuotes &&
                    (item.quotes ?? []).map((quote, q) => (
                      <p key={q} className="mt-0.5 border-l-2 border-zinc-200 pl-2 text-xs italic text-zinc-500">
                        “{quote}”
                      </p>
                    ))}
                </div>
                <TimeButton time={item.start_time} onWatchVideo={onWatchVideo} />
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

/** Meeting-level card: the headline pledges as tiles, then every pledge by theme on request. */
export function CommitmentsCard({
  commitments,
  itemHref,
  itemTitle,
  onWatchVideo,
}: {
  commitments: ItemCommitments;
  itemHref: string;
  itemTitle: string;
  onWatchVideo?: (startTime: number) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const [showQuotes, setShowQuotes] = useState(false);
  const items = commitments.items ?? [];
  const key = keyCommitments(items);

  return (
    <div className="rounded-2xl border border-brand-200 bg-brand-50/40 p-5 shadow-sm sm:p-6">
      <p className="text-sm text-zinc-600">
        {items.length} pledges from the{" "}
        <a href={itemHref} className="font-medium text-brand-700 hover:underline">
          {itemTitle.toLowerCase()}
        </a>
        , each linked to the moment in the video.
      </p>

      {key.length > 0 && (
        <ul className="mt-4 grid gap-3 sm:grid-cols-2">
          {key.map((item, i) => (
            <li key={i} className="flex flex-col justify-between gap-2 rounded-xl border border-brand-100 bg-surface p-4 shadow-xs">
              <p className="font-semibold leading-snug text-zinc-900">{item.short ?? item.text}</p>
              <div className="flex items-center justify-between gap-2 text-xs text-zinc-500">
                <span>{item.group}</span>
                {item.start_time != null && onWatchVideo && (
                  <button
                    type="button"
                    onClick={() => onWatchVideo(item.start_time!)}
                    className="inline-flex items-center gap-1 font-medium text-brand-600 hover:text-brand-700"
                  >
                    <PlayCircle className="h-3.5 w-3.5" />
                    <span className="font-mono tabular-nums">{formatTimestamp(item.start_time)}</span>
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-4 flex items-center justify-between gap-3 border-t border-brand-100 pt-4">
        <button
          type="button"
          onClick={() => setShowAll((v) => !v)}
          aria-expanded={showAll}
          className="inline-flex items-center gap-1.5 text-sm font-semibold text-brand-700 hover:text-brand-800"
        >
          {showAll ? "Hide the full list" : `All ${items.length} pledges by theme`}
          <ChevronDown className={cn("h-4 w-4 transition-transform", showAll && "rotate-180")} />
        </button>
        {showAll && <QuotesToggle showQuotes={showQuotes} onToggle={() => setShowQuotes((v) => !v)} />}
      </div>
      {showAll && (
        <div className="mt-4">
          <CommitmentGroups items={items} showQuotes={showQuotes} onWatchVideo={onWatchVideo} />
        </div>
      )}
    </div>
  );
}

/** Inside the agenda item: the same pledges, for readers who open the item itself. */
export function ItemCommitmentsList({
  commitments,
  onWatchVideo,
}: {
  commitments: ItemCommitments;
  onWatchVideo: (startTime: number) => void;
}) {
  const [showQuotes, setShowQuotes] = useState(false);
  const items = commitments.items ?? [];
  if (items.length === 0) return null;
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h4 className="flex items-center gap-2 text-xs font-semibold text-zinc-500">
          <Flag className="w-3 h-3 text-brand-600" />
          {commitments.title ?? "Commitments"} ({items.length})
        </h4>
        <QuotesToggle showQuotes={showQuotes} onToggle={() => setShowQuotes((v) => !v)} />
      </div>
      {commitments.note && <p className="pl-5 text-xs text-zinc-500">{commitments.note}</p>}
      <div className="pl-5">
        <CommitmentGroups items={items} showQuotes={showQuotes} onWatchVideo={onWatchVideo} />
      </div>
    </div>
  );
}
