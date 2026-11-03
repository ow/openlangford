import { Mic } from "lucide-react";
import { formatTimestamp } from "../../lib/timeline-utils";

type RemarkPoint = { text: string; start_time?: number | null };
type Speaker = { name: string; role?: string; start_time?: number | null; points?: RemarkPoint[] };
export type ItemRemarks = { title?: string; speakers?: Speaker[] };

/** Speeches at an item (agenda_items.meta.remarks): who spoke, whom they represent, and a few points each. */
export function ItemRemarksList({
  remarks,
  onWatchVideo,
}: {
  remarks: ItemRemarks;
  onWatchVideo: (startTime: number) => void;
}) {
  const speakers = remarks.speakers ?? [];
  if (speakers.length === 0) return null;
  const watch = (time?: number | null) =>
    time != null && (
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

  return (
    <div className="space-y-2">
      <h4 className="flex items-center gap-2 text-xs font-semibold text-zinc-500">
        <Mic className="w-3 h-3 text-amber-500" />
        {remarks.title ?? "Remarks"}
      </h4>
      <div className="pl-5 space-y-4">
        {speakers.map((speaker, i) => (
          <div key={i} className="space-y-1">
            <div className="flex items-baseline justify-between gap-3">
              <p className="text-sm text-zinc-900">
                <span className="font-semibold">{speaker.name}</span>
                {speaker.role && <span className="text-zinc-500"> · {speaker.role}</span>}
              </p>
              {watch(speaker.start_time)}
            </div>
            <ul className="space-y-1">
              {(speaker.points ?? []).map((point, j) => (
                <li key={j} className="flex gap-2 text-sm leading-relaxed text-zinc-700">
                  <span aria-hidden className="mt-2 h-1 w-1 shrink-0 rounded-full bg-zinc-400" />
                  <span>{point.text}</span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}
