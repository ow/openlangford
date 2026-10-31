import type { TermSummary, YearSummary } from "../lib/closed-sessions";
import { aboutDuration } from "../lib/closed-sessions";

const STEP = 34;
const BAR = 18;
const LEFT = 26;
const TOP = 26;
const PLOT = 130;
const BOTTOM = 18;

const shortTerm = (name: string) => name.replace(/\s*council$/i, "");

function yearFraction(date: string) {
  const y = +date.slice(0, 4);
  const start = Date.UTC(y, 0, 1);
  const end = Date.UTC(y + 1, 0, 1);
  return y + (Date.UTC(y, +date.slice(5, 7) - 1, +date.slice(8, 10)) - start) / (end - start);
}

/** A bar with a rounded top, anchored to the baseline. */
function barPath(x: number, y: number, w: number, h: number, r = 3) {
  if (h <= 0) return "";
  const rr = Math.min(r, h, w / 2);
  return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`;
}

function describeYear(y: YearSummary, through: string) {
  const partial = String(y.year) === through.slice(0, 4);
  const head = `${y.year}${partial ? " (so far)" : ""}: ${y.sessions} closed session${y.sessions === 1 ? "" : "s"}`;
  if (!y.sessions) return head;
  if (!y.measurable || y.closedHours == null) return `${head} · length not measurable`;
  return `${head} · ${aboutDuration(y.closedHours * 60)} closed${y.closedShare != null ? ` · ${Math.round(y.closedShare * 100)}% of meeting time` : ""}`;
}

/** Closed sessions per year, with council terms marked by dashed lines at their start. */
export function ClosedSessionsChart({ years, terms, through }: { years: YearSummary[]; terms: TermSummary[]; through: string }) {
  if (!years.length) return null;
  const y0 = years[0].year;
  const y1 = years.at(-1)!.year;
  const n = y1 - y0 + 1;
  const width = LEFT + n * STEP + 4;
  const height = TOP + PLOT + BOTTOM;
  const max = Math.max(5, Math.ceil(Math.max(...years.map((y) => y.sessions)) / 5) * 5);
  const yOf = (v: number) => TOP + PLOT - (v / max) * PLOT;
  const xOfDate = (date: string) => LEFT + (Math.min(Math.max(yearFraction(date), y0), y1 + 1) - y0) * STEP;
  const ticks = Array.from({ length: Math.floor(max / 5) + 1 }, (_, i) => i * 5).filter((t) => max <= 20 || t % 10 === 0);
  const peak = years.reduce((a, b) => (b.sessions > a.sessions ? b : a));
  const latest = years.at(-1)!;
  const byYear = new Map(years.map((y) => [y.year, y]));
  const ordered = [...terms].sort((a, b) => a.start_date.localeCompare(b.start_date));

  return (
    <figure className="rounded-2xl border border-zinc-200 bg-surface px-4 py-3 shadow-sm">
      <figcaption className="mb-2 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-xs text-zinc-500">
        <span>
          <span className="font-semibold text-zinc-900">Closed sessions each year</span>, {y0}–{y1}
          {String(y1) === through.slice(0, 4) && <> ({y1} so far)</>}
        </span>
      </figcaption>
      <div className="-mx-1 overflow-x-auto px-1 pb-1">
        <svg viewBox={`0 0 ${width} ${height}`} className="block h-auto w-full min-w-[560px] text-[10px]" aria-hidden="true">
          {/* Each council term starts at a dashed line, labelled with its years. */}
          {ordered.map((t) => {
            const x = xOfDate(t.start_date);
            return (
              <g key={t.name}>
                {x > LEFT && <line x1={x} x2={x} y1={TOP - 18} y2={TOP + PLOT} className="stroke-zinc-400" strokeWidth={0.75} strokeDasharray="3 3" />}
                <text x={x + 4} y={TOP - 7} className="fill-zinc-500">{shortTerm(t.name)}</text>
              </g>
            );
          })}
          {ticks.map((t) => (
            <g key={t}>
              <line x1={LEFT} x2={width - 4} y1={yOf(t)} y2={yOf(t)} className={t === 0 ? "stroke-zinc-400" : "stroke-zinc-200"} strokeWidth={t === 0 ? 1 : 0.75} />
              <text x={LEFT - 6} y={yOf(t) + 3} textAnchor="end" className="fill-zinc-400">{t}</text>
            </g>
          ))}
          {Array.from({ length: n }, (_, i) => y0 + i).map((year) => {
            const y = byYear.get(year) ?? { year, sessions: 0, measurable: false, closedHours: null, closedShare: null };
            const cx = LEFT + (year - y0 + 0.5) * STEP;
            const top = yOf(y.sessions);
            const labelled = year === peak.year || year === latest.year;
            return (
              <g key={year}>
                <title>{describeYear(y, through)}</title>
                <rect x={cx - STEP / 2} y={TOP} width={STEP} height={PLOT} className="fill-transparent" />
                <path d={barPath(cx - BAR / 2, top, BAR, TOP + PLOT - top)} className="fill-brand-600" />
                {labelled && y.sessions > 0 && (
                  <text x={cx} y={top - 4} textAnchor="middle" className="fill-zinc-700 font-semibold">{y.sessions}</text>
                )}
                {((year - y0) % 2 === 0 || year === y1) && (
                  <text x={cx} y={TOP + PLOT + 13} textAnchor="middle" className="fill-zinc-500 tabular-nums">{year}</text>
                )}
              </g>
            );
          })}
        </svg>
      </div>
      <table className="sr-only">
        <caption>Closed sessions each year</caption>
        <thead><tr><th>Year</th><th>Closed sessions</th><th>Time closed</th></tr></thead>
        <tbody>
          {years.map((y) => (
            <tr key={y.year}>
              <td>{y.year}</td>
              <td>{y.sessions}</td>
              <td>{y.measurable && y.closedHours != null ? aboutDuration(y.closedHours * 60) : "not measurable"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}
