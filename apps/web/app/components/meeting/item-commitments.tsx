import { useState } from "react";
import { Flag } from "lucide-react";
import { formatTimestamp } from "../../lib/timeline-utils";

type Commitment = { group?: string; text: string; quotes?: string[]; start_time?: number | null };
export type ItemCommitments = { title?: string; note?: string; items?: Commitment[] };

/** The first agenda item carrying pledges from a speech (agenda_items.meta.commitments), for the meeting-level section. */
export function meetingCommitments(items: { id: number; title?: string | null; meta?: any }[]) {
  const item = items.find((it) => (it.meta?.commitments?.items?.length ?? 0) > 0);
  return item ? { itemId: item.id, itemTitle: item.title ?? "", commitments: item.meta.commitments as ItemCommitments } : null;
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

function CommitmentGroups({
  items,
  showQuotes,
  onWatchVideo,
  columns = false,
}: {
  items: Commitment[];
  showQuotes: boolean;
  onWatchVideo?: (startTime: number) => void;
  columns?: boolean;
}) {
  return (
    <div className={columns ? "grid gap-x-8 gap-y-5 sm:grid-cols-2" : "space-y-3"}>
      {grouped(items).map((group) => (
        <div key={group.name} className="space-y-1.5">
          {group.name && <p className="text-xs font-semibold text-zinc-700">{group.name}</p>}
          <ul className="space-y-1.5">
            {group.items.map((item, i) => (
              <li key={i} className="flex gap-2 text-sm leading-relaxed text-zinc-800">
                <span aria-hidden className="mt-2 h-1 w-1 shrink-0 rounded-full bg-brand-500" />
                <div className="min-w-0">
                  <span>{item.text}</span>
                  {item.start_time != null && onWatchVideo && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onWatchVideo(item.start_time!);
                      }}
                      className="ml-1.5 font-mono text-xs text-brand-600 hover:text-brand-700 hover:underline"
                      aria-label={`Watch at ${formatTimestamp(item.start_time)}`}
                    >
                      {formatTimestamp(item.start_time)}
                    </button>
                  )}
                  {showQuotes &&
                    (item.quotes ?? []).map((quote, q) => (
                      <p key={q} className="mt-0.5 border-l-2 border-zinc-200 pl-2 text-xs italic text-zinc-500">
                        “{quote}”
                      </p>
                    ))}
                </div>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

/** Meeting-level card: the pledges made in a speech at this meeting, given prominence below the summary. */
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
  const [showQuotes, setShowQuotes] = useState(false);
  const items = commitments.items ?? [];
  return (
    <div className="rounded-2xl border border-brand-200 bg-brand-50/40 p-5 shadow-sm sm:p-6">
      <div className="mb-4 flex items-start justify-between gap-3">
        <p className="text-sm text-zinc-600">
          {items.length} pledges from the{" "}
          <a href={itemHref} className="font-medium text-brand-700 hover:underline">
            {itemTitle.toLowerCase()}
          </a>
          , each linked to the moment in the video.
        </p>
        <QuotesToggle showQuotes={showQuotes} onToggle={() => setShowQuotes((v) => !v)} />
      </div>
      <CommitmentGroups items={items} showQuotes={showQuotes} onWatchVideo={onWatchVideo} columns />
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
