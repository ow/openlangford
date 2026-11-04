import { useState } from "react";
import { cn, formatDate } from "~/lib/utils";

export type Point = { day: string; value: number };

const SHORT_DAY: Intl.DateTimeFormatOptions = { weekday: "short", month: "short", day: "numeric" };
const AXIS_DAY: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };
const n = (value: number) => value.toLocaleString();

/** A point's label: days as dates; hourly points (an ISO time) as Pacific times. */
function when(day: string, options: Intl.DateTimeFormatOptions) {
  if (!day.includes("T")) return formatDate(day, options);
  const date = new Date(day);
  return date.toLocaleString("en-CA", options === SHORT_DAY
    ? { timeZone: "America/Vancouver", weekday: "short", hour: "numeric", minute: "2-digit" }
    : { timeZone: "America/Vancouver", hour: "numeric" });
}

/** Rounds up to 1, 2 or 5 times a power of ten, so axis labels read cleanly. */
function niceMax(value: number) {
  if (value <= 4) return 4;
  const power = 10 ** Math.floor(Math.log10(value));
  const step = [1, 2, 5, 10].find((s) => s * power >= value)!;
  return step * power;
}

function ChartTable({ caption, data, unit }: { caption: string; data: Point[]; unit: string }) {
  return (
    <table className="sr-only">
      <caption>{caption}</caption>
      <thead>
        <tr>
          <th>Day</th>
          <th>{unit}</th>
        </tr>
      </thead>
      <tbody>
        {data.map((d) => (
          <tr key={d.day}>
            <td>{when(d.day, SHORT_DAY)}</td>
            <td>{d.value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function YAxis({ max, min = 0 }: { max: number; min?: number }) {
  return (
    <>
      {[1, 0.5, 0].map((f) => (
        <div key={f} className="pointer-events-none absolute inset-x-0 flex items-center" style={{ top: `${(1 - f) * 100}%` }}>
          <span className="absolute -left-1 -translate-x-full -translate-y-1/2 text-[11px] tabular-nums text-zinc-400">{n(Math.round(min + (max - min) * f))}</span>
          <div className={cn("h-px w-full -translate-y-1/2", f === 0 ? "bg-zinc-300" : "bg-zinc-100")} />
        </div>
      ))}
    </>
  );
}

function XAxis({ data }: { data: Point[] }) {
  if (data.length === 0) return null;
  const mid = data[Math.floor((data.length - 1) / 2)];
  return (
    <div className="mt-1.5 flex justify-between text-[11px] text-zinc-400">
      <span>{when(data[0].day, AXIS_DAY)}</span>
      <span>{when(mid.day, AXIS_DAY)}</span>
      <span>{when(data.at(-1)!.day, AXIS_DAY)}</span>
    </div>
  );
}

function Tooltip({ x, point, unit }: { x: number; point: Point; unit: string }) {
  return (
    <div
      className="pointer-events-none absolute -top-2 z-10 -translate-y-full whitespace-nowrap rounded-lg bg-zinc-900 px-2.5 py-1.5 text-xs text-white shadow-lg"
      style={{ left: `${x}%`, transform: `translate(${x > 75 ? "-100%" : x < 25 ? "0" : "-50%"}, -100%)` }}
    >
      <div className="text-zinc-300">{when(point.day, SHORT_DAY)}</div>
      <div className="font-semibold tabular-nums">
        {n(point.value)} {unit}
      </div>
    </div>
  );
}

/** One series over time: a 2px line with a soft fill, crosshair and tooltip on hover. */
/** An axis that starts just below the data instead of at zero, so a small change in a large number shows. */
function zoomedRange(values: number[]) {
  const lo = Math.min(...values), hi = Math.max(...values);
  const span = niceMax(Math.max(hi - lo, 4) * 1.5);
  const min = Math.max(0, Math.floor((lo - span * 0.2) / (span / 4)) * (span / 4));
  return { min, max: min + Math.max(span, niceMax(hi - min)) };
}

export function AreaChart({ data, unit, label, height = 220, zoom = false }: {
  data: Point[]; unit: string; label: string; height?: number;
  /** Start the axis near the data rather than at zero (for a large total that changes a little). */
  zoom?: boolean;
}) {
  const [active, setActive] = useState<number | null>(null);
  const values = data.map((d) => d.value);
  const { min, max } = zoom && values.length ? zoomedRange(values) : { min: 0, max: niceMax(Math.max(0, ...values)) };
  const last = Math.max(data.length - 1, 1);
  const x = (i: number) => (i / last) * 100;
  const y = (v: number) => 100 - ((v - min) / (max - min)) * 100;
  const line = data.map((d, i) => `${i === 0 ? "M" : "L"}${x(i)},${y(d.value)}`).join(" ");
  const point = active == null ? null : data[active];

  return (
    <figure className="pt-3 pl-8">
      <div
        className="relative"
        style={{ height }}
        onMouseMove={(e) => {
          const box = e.currentTarget.getBoundingClientRect();
          setActive(Math.round(((e.clientX - box.left) / box.width) * last));
        }}
        onMouseLeave={() => setActive(null)}
      >
        <YAxis max={max} min={min} />
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="absolute inset-0 h-full w-full overflow-visible" aria-hidden="true">
          <path d={`${line} L100,100 L0,100 Z`} className="fill-brand-600/10" />
          <path d={line} fill="none" vectorEffect="non-scaling-stroke" strokeWidth={2} strokeLinejoin="round" className="stroke-brand-600" />
        </svg>
        {point && active != null && (
          <>
            <div className="pointer-events-none absolute inset-y-0 w-px bg-zinc-300" style={{ left: `${x(active)}%` }} />
            <div
              className="pointer-events-none absolute h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-brand-600 ring-2 ring-white"
              style={{ left: `${x(active)}%`, top: `${y(point.value)}%` }}
            />
            <Tooltip x={x(active)} point={point} unit={unit} />
          </>
        )}
      </div>
      <XAxis data={data} />
      <ChartTable caption={label} data={data} unit={unit} />
    </figure>
  );
}

/** Daily counts as thin bars with a 2px gap; hover a bar for its value. */
export function BarChart({ data, unit, label, height = 120 }: { data: Point[]; unit: string; label: string; height?: number }) {
  const [active, setActive] = useState<number | null>(null);
  const max = niceMax(Math.max(0, ...data.map((d) => d.value)));
  return (
    <figure className="pt-3 pl-6">
      <div className="relative" style={{ height }} onMouseLeave={() => setActive(null)}>
        <YAxis max={max} />
        <div className="absolute inset-0 flex items-end gap-[2px]">
          {data.map((d, i) => (
            <div key={d.day} className="flex h-full flex-1 items-end" onMouseEnter={() => setActive(i)}>
              <div
                className={cn("w-full rounded-t-[4px]", active === i ? "bg-brand-700" : "bg-brand-600")}
                style={{ height: d.value > 0 ? `max(2px, ${(d.value / max) * 100}%)` : 0 }}
              />
            </div>
          ))}
        </div>
        {active != null && data[active] && <Tooltip x={((active + 0.5) / data.length) * 100} point={data[active]} unit={unit} />}
      </div>
      <XAxis data={data} />
      <ChartTable caption={label} data={data} unit={unit} />
    </figure>
  );
}

/** A tiny trend line for stat tiles. Decorative: the tile states the number. */
export function Sparkline({ data, className }: { data: Point[]; className?: string }) {
  if (data.length < 2) return null;
  const max = Math.max(1, ...data.map((d) => d.value));
  const last = data.length - 1;
  const line = data.map((d, i) => `${i === 0 ? "M" : "L"}${(i / last) * 100},${30 - (d.value / max) * 28}`).join(" ");
  return (
    <svg viewBox="0 0 100 30" preserveAspectRatio="none" className={cn("h-8 w-full overflow-visible", className)} aria-hidden="true">
      <path d={`${line} L100,30 L0,30 Z`} className="fill-brand-600/10" />
      <path d={line} fill="none" vectorEffect="non-scaling-stroke" strokeWidth={2} strokeLinejoin="round" className="stroke-brand-600" />
    </svg>
  );
}

/** Ranked list with a proportional bar behind each label. */
export function BarList({ items, renderLabel }: { items: { label: string; value: number }[]; renderLabel?: (label: string) => React.ReactNode }) {
  const max = Math.max(1, ...items.map((i) => i.value));
  return (
    <ol className="space-y-1">
      {items.map((item) => (
        <li key={item.label} className="relative flex items-center justify-between gap-3 px-2 py-1 text-sm">
          <div className="absolute inset-y-0 left-0 rounded-md bg-brand-600/10" style={{ width: `${(item.value / max) * 100}%` }} aria-hidden="true" />
          <span className="relative min-w-0 truncate text-zinc-800">{renderLabel ? renderLabel(item.label) : item.label}</span>
          <span className="relative shrink-0 tabular-nums text-zinc-600">{n(item.value)}</span>
        </li>
      ))}
    </ol>
  );
}
