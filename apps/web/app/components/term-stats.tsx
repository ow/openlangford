import { Link } from "react-router";
import { CalendarDays, CircleCheck, ScrollText, TrendingUp, type LucideIcon } from "lucide-react";
import type { CouncilTermStats } from "../services/council-summary.server";

const count = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

type Part = { label: string; value: number; className: string };

/** A thin bar split by share, with its key underneath. */
function Breakdown({ parts }: { parts: Part[] }) {
  const total = parts.reduce((sum, part) => sum + part.value, 0);
  if (parts.length < 2 || !total) return null;
  return (
    <div className="mt-4">
      <div className="flex h-1.5 overflow-hidden rounded-full bg-zinc-100">
        {parts.map((part) => <div key={part.label} className={part.className} style={{ width: `${(part.value / total) * 100}%` }} />)}
      </div>
      <ul className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-zinc-500">
        {parts.map((part) => (
          <li key={part.label} className="flex items-center gap-1.5">
            <span aria-hidden className={`h-2 w-2 rounded-full ${part.className}`} />
            <span className="tabular-nums">{part.value.toLocaleString()}</span> {part.label}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Counts per quarter of the term as small bars, stacked when there are several series (carried, defeated). */
function QuarterBars({ points, colors, what, start, end }: {
  points: { month: string; values: number[] }[]; colors: string[]; what: string; start: string; end: string;
}) {
  const monthIndex = (date: string) => Number(date.slice(0, 4)) * 12 + Number(date.slice(5, 7)) - 1;
  const first = monthIndex(start);
  const quarters = Array.from({ length: Math.floor((monthIndex(end) - first) / 3) + 1 }, () => colors.map(() => 0));
  for (const point of points) {
    const q = Math.floor((monthIndex(point.month) - first) / 3);
    if (q >= 0 && q < quarters.length) point.values.forEach((n, k) => { if (k < colors.length) quarters[q][k] += n; });
  }
  const totals = quarters.map((q) => q.reduce((a, b) => a + b, 0));
  const max = Math.max(...totals);
  if (quarters.length < 2 || !max) return null;
  return (
    <div className="mt-4">
      <div className="flex h-12 items-end gap-0.5" role="img" aria-label={`${what} each quarter, from ${start.slice(0, 4)} to ${end.slice(0, 4)}; the most in one quarter was ${max}.`}>
        {quarters.map((values, i) => (
          <div key={i} className="flex flex-1 flex-col-reverse overflow-hidden rounded-sm" style={{ height: `${Math.max(totals[i] ? 8 : 2, (totals[i] / max) * 100)}%`, opacity: totals[i] ? 1 : 0.25 }} title={`${totals[i]} in quarter ${i + 1}`}>
            {totals[i] ? values.map((n, k) => n > 0 && <div key={k} className={colors[k]} style={{ height: `${(n / totals[i]) * 100}%` }} />) : <div className={`h-full ${colors[0]}`} />}
          </div>
        ))}
      </div>
      <div className="mt-1.5 flex justify-between text-xs tabular-nums text-zinc-500">
        <span>{start.slice(0, 4)}</span>
        <span>By quarter</span>
        <span>{end.slice(0, 4)}</span>
      </div>
    </div>
  );
}

/** The key under the motions chart: carried and (when any are minuted) defeated. */
function MotionKey({ parts }: { parts: Part[] }) {
  return (
    <ul className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-zinc-500">
      {parts.map((part) => (
        <li key={part.label} className="flex items-center gap-1.5">
          <span aria-hidden className={`h-2 w-2 rounded-full ${part.className}`} />
          <span className="tabular-nums">{part.value.toLocaleString()}</span> {part.label}
        </li>
      ))}
    </ul>
  );
}

function StatCard({ icon: Icon, label, value, children }: { icon: LucideIcon; label: string; value: number; children?: React.ReactNode }) {
  return (
    <div className="flex flex-col rounded-2xl border border-zinc-200 bg-surface p-5 shadow-sm">
      <div className="flex items-center gap-2 text-sm font-medium text-zinc-600">
        <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-brand-50 text-brand-600">
          <Icon className="h-4 w-4" />
        </span>
        {label}
      </div>
      <p className="mt-3 text-4xl font-bold tracking-tight tabular-nums text-zinc-900">{value.toLocaleString()}</p>
      {children}
    </div>
  );
}

/** The selected term at a glance: meetings held, decisions, bylaws adopted, and the topics that came back most often. */
export function TermStats({ stats, inProgress, start, end }: { stats: CouncilTermStats; inProgress: boolean; start: string; end: string }) {
  const months = Math.max(1, (Date.parse(end) - Date.parse(start)) / (30.44 * 86_400_000));
  if (!stats.meetings) return null;
  const perMonth = (n: number) => {
    const rate = n / months;
    return rate >= 1 ? `About ${Math.round(rate)} a month` : `About 1 every ${Math.round(1 / rate)} months`;
  };
  // Older minutes are incomplete (few committee meetings, defeated motions rarely minuted), so zero parts are left out
  // rather than shown as a count of none.
  const meetingParts = ([
    { label: "regular", value: stats.regularCouncil, className: "bg-brand-500" },
    { label: "special", value: stats.specialCouncil, className: "bg-brand-300" },
    { label: "committee of the whole", value: stats.committeeOfTheWhole, className: "bg-amber-400" },
    { label: stats.committees === 1 ? "committee or board" : "committees and boards", value: stats.committees, className: "bg-zinc-400" },
  ] as Part[]).filter((part) => part.value > 0);
  const motionParts = ([
    { label: "carried", value: stats.motionsCarried, className: "bg-brand-500" },
    { label: "defeated", value: stats.motionsDefeated, className: "bg-amber-400" },
  ] as Part[]).filter((part) => part.value > 0);

  return (
    <section aria-labelledby="term-stats-heading" className="flex flex-col gap-4">
      <h2 id="term-stats-heading" className="text-lg font-bold tracking-tight text-zinc-900">{inProgress ? "This term so far" : "This term"}</h2>
      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard icon={CalendarDays} label="Meetings held" value={stats.meetings}>
          <Breakdown parts={meetingParts} />
        </StatCard>
        <StatCard icon={CircleCheck} label="Motions decided" value={stats.motionsCarried + stats.motionsDefeated}>
          <QuarterBars points={stats.motionsByMonth.map((m) => ({ month: m.month, values: [m.carried, m.defeated] }))} colors={["bg-brand-500", "bg-amber-400"]} what="Motions decided" start={start} end={end} />
          <MotionKey parts={motionParts} />
        </StatCard>
        <StatCard icon={ScrollText} label="Bylaws adopted" value={stats.bylawsAdopted}>
          <QuarterBars points={stats.bylawAdoptionDates.map((date) => ({ month: date, values: [1] }))} colors={["bg-brand-500"]} what="Bylaws adopted" start={start} end={end} />
          {months >= 3 && stats.bylawsAdopted > 0 && <p className="mt-2 text-xs text-zinc-500">{perMonth(stats.bylawsAdopted)}</p>}
        </StatCard>
      </div>
      {stats.topics.length > 0 && (
        <div className="rounded-2xl border border-zinc-200 bg-surface p-5 shadow-sm">
          <h3 className="flex items-center gap-2 text-sm font-medium text-zinc-600">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-brand-50 text-brand-600">
              <TrendingUp className="h-4 w-4" />
            </span>
            On the agenda most often
          </h3>
          <ol className="mt-3 divide-y divide-zinc-100">
            {stats.topics.map((topic, i) => (
              <li key={topic.slug} className="flex items-baseline gap-3 py-2 text-sm">
                <span className="w-4 shrink-0 text-xs tabular-nums text-zinc-400">{i + 1}</span>
                <Link to={`/matters/${topic.slug}`} className="min-w-0 flex-1 truncate font-medium text-zinc-800 hover:text-brand-700">
                  {topic.title}
                </Link>
                <span className="shrink-0 text-xs tabular-nums text-zinc-500">{count(topic.meetings, "meeting")}</span>
              </li>
            ))}
          </ol>
        </div>
      )}
    </section>
  );
}
