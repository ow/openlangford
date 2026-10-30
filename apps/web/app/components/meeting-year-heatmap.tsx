import { useMemo } from "react";
import { Link } from "react-router";
import type { Meeting } from "../lib/types";
import type { MeetingStats } from "../services/meetings";
import { monthTotals, yearGrid, type HeatDay } from "../lib/activity-charts";
import { meetingPath } from "../lib/paths";

const CELL = 11;
const STEP = 14;
const LEFT = 28;
const TOP = 16;
// Tailwind scales flip under html.dark, so these stay "more = stronger" in both themes.
const FILLS = ["fill-zinc-200/70", "fill-brand-200", "fill-brand-400", "fill-brand-600", "fill-brand-800"];
const SWATCHES = ["bg-zinc-200/70", "bg-brand-200", "bg-brand-400", "bg-brand-600", "bg-brand-800"];

const longDate = (date: string) =>
  new Date(`${date}T12:00:00Z`).toLocaleDateString("en-CA", { weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const duration = (seconds: number) => {
  const minutes = Math.round(seconds / 60);
  return minutes >= 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60} min` : `${minutes} min`;
};

/** Agenda items stand in for meeting length: video length exists for only a few recent meetings. */
function describe(day: HeatDay) {
  return [
    longDate(day.date),
    ...day.meetings.map((m) =>
      [m.title, plural(m.items, "agenda item"), m.seconds ? `${duration(m.seconds)} of video` : null].filter(Boolean).join(" · "),
    ),
  ].join("\n");
}

export function MeetingYearHeatmap({ year, meetings, statsMap }: { year: number; meetings: Meeting[]; statsMap: Record<number, MeetingStats> }) {
  const { days, months, weeks } = useMemo(
    () =>
      yearGrid(
        year,
        meetings.map((m) => {
          const stats = statsMap[m.id];
          // Older cached lists lack the item count; recorded motions are the nearest stand-in.
          const items = m.agenda_item_count?.[0]?.count ?? (stats ? stats.motion_carried_count + stats.motion_defeated_count + stats.motion_other_count : 0);
          return { id: m.id, slug: m.slug, title: m.title, meeting_date: m.meeting_date, items, seconds: m.video_duration_seconds || null };
        }),
      ),
    [year, meetings, statsMap],
  );
  const today = new Date().toLocaleDateString("en-CA");
  const totals = monthTotals(days);
  const meetingDays = days.filter((d) => d.meetings.length);
  const meetingCount = meetingDays.reduce((n, d) => n + d.meetings.length, 0);
  const busiest = totals.reduce((a, b) => (b.meetings > a.meetings ? b : a));
  const width = LEFT + weeks * STEP;
  // Council doesn't meet on weekends; keep those rows only in a year that had a weekend meeting.
  const showWeekends = meetingDays.some((d) => d.row >= 5);
  const shown = showWeekends ? days : days.filter((d) => d.row < 5);
  const height = TOP + (showWeekends ? 7 : 5) * STEP;

  return (
    <figure className="mb-6 rounded-2xl border border-zinc-200 bg-surface px-4 py-3 shadow-sm">
      <figcaption className="mb-2 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-xs text-zinc-500">
        <span>
          <span className="font-semibold text-zinc-900">{plural(meetingCount, "meeting")}</span> on {plural(meetingDays.length, "day")} in {year}
          {meetingCount > 0 && <> · busiest in {busiest.label}</>}
        </span>
        <span className="flex items-center gap-1" aria-hidden="true">
          Fewer
          {SWATCHES.slice(1).map((c) => (
            <span key={c} className={`inline-block h-2.5 w-2.5 rounded-[2px] ${c}`} />
          ))}
          More agenda items
        </span>
      </figcaption>
      <div className="-mx-1 overflow-x-auto px-1 pb-1">
        <svg viewBox={`0 0 ${width} ${height}`} className="block h-auto w-full min-w-[620px] text-[10px]" aria-hidden="true">
          {months.map((m) => (
            <text key={m.label} x={LEFT + m.col * STEP} y={10} className="fill-zinc-500">
              {m.label}
            </text>
          ))}
          {["Mon", "Wed", "Fri"].map((label, i) => (
            <text key={label} x={0} y={TOP + i * 2 * STEP + CELL - 2} className="fill-zinc-400">
              {label}
            </text>
          ))}
          {shown.map((d) => {
            const rect = (
              <rect
                x={LEFT + d.col * STEP}
                y={TOP + d.row * STEP}
                width={CELL}
                height={CELL}
                rx={2}
                className={d.level ? FILLS[d.level] : d.date > today ? "fill-zinc-200/30" : FILLS[0]}
              />
            );
            if (!d.meetings.length) return <g key={d.date}>{rect}</g>;
            const target = [...d.meetings].sort((a, b) => b.items - a.items)[0];
            return (
              <Link key={d.date} to={meetingPath(target)} tabIndex={-1} className="[&>rect]:hover:stroke-zinc-900 [&>rect]:hover:stroke-[1.5]">
                <title>{describe(d)}</title>
                {rect}
              </Link>
            );
          })}
        </svg>
      </div>
      <div className="sr-only">
        <p>Meetings per month in {year}. Every meeting is listed below.</p>
        <ul>
          {totals.map((m) => (
            <li key={m.label}>
              {m.label}: {plural(m.meetings, "meeting")}, {plural(m.items, "agenda item")}
            </li>
          ))}
        </ul>
      </div>
    </figure>
  );
}
