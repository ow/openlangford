import { Link } from "react-router";
import type { SpeakerNamingDashboard } from "../../services/speaker-naming-admin.server";
import { meetingPath } from "../../lib/paths";
import { cn, formatDate } from "../../lib/utils";

const card = "rounded-2xl border border-zinc-200 bg-surface shadow-sm";
const pct = (share: number | null) => (share == null ? "—" : `${Math.round(share * 100)}%`);

/** Share of transcript speech with a speaker name, so a change to speaker naming shows what it fixed. */
export function SpeakerNamingSection({ naming }: { naming: SpeakerNamingDashboard }) {
  return (
    <section aria-labelledby="speaker-naming-heading" className="mt-10">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
        <div className="flex items-baseline gap-3">
          <h2 id="speaker-naming-heading" className="text-lg font-semibold text-zinc-900">Speaker names</h2>
          <span className="text-sm tabular-nums text-zinc-500">{naming.meetings.toLocaleString()} meetings with a transcript</span>
        </div>
        <Link to="/admin/names" className="text-sm font-medium text-brand-700 hover:text-brand-900">
          {naming.awaitingReview.toLocaleString()} {naming.awaitingReview === 1 ? "name" : "names"} to review
        </Link>
      </div>
      <div className={cn(card, "grid grid-cols-2 gap-px overflow-hidden bg-zinc-200")}>
        <div className="bg-surface px-5 py-4">
          <div className="text-sm font-medium text-zinc-600">Speech with a name</div>
          <div className="mt-1 text-3xl font-semibold tabular-nums tracking-tight text-zinc-950">{pct(naming.average)}</div>
          <p className="mt-1 text-xs text-zinc-500">Average across every meeting</p>
        </div>
        <div className="bg-surface px-5 py-4">
          <div className="text-sm font-medium text-zinc-600">Last 20 meetings</div>
          <div className="mt-1 text-3xl font-semibold tabular-nums tracking-tight text-zinc-950">{pct(naming.recentAverage)}</div>
          <p className="mt-1 text-xs text-zinc-500">Average share named</p>
        </div>
      </div>
      {naming.lowest.length > 0 && (
        <div className={cn(card, "mt-3 overflow-hidden")}>
          <div className="border-b border-zinc-100 px-5 py-2.5 text-xs font-medium text-zinc-500">Fewest names, recent meetings</div>
          <ul className="divide-y divide-zinc-100">
            {naming.lowest.map((m) => (
              <li key={m.id} className="flex items-center justify-between gap-4 px-5 py-2.5 text-sm">
                <Link to={`${meetingPath(m, "/explorer")}?tab=transcript`} className="min-w-0 truncate text-zinc-800 hover:text-brand-700">
                  <span className="tabular-nums text-zinc-500">{formatDate(m.meeting_date)}</span> · {m.title}
                </Link>
                <span className="shrink-0 tabular-nums text-zinc-600">{pct(m.share)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
