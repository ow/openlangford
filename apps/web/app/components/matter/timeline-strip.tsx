import { cn, formatDate } from "../../lib/utils";
import { OUTCOME_LABEL, OUTCOME_ORDER, type AppearanceOutcome, type Strip } from "../../lib/matter-timeline";

/** Shape + colour per outcome, so the strip reads without relying on hue alone. */
const MARK: Record<AppearanceOutcome, string> = {
  passed: "h-3 w-3 rounded-full bg-brand-500",
  defeated: "h-2.5 w-2.5 rotate-45 bg-amber-500",
  deferred: "h-3 w-3 rounded-full border-2 border-violet-500 bg-surface",
  comment: "h-2.5 w-2.5 rounded-[2px] bg-sky-500",
  discussed: "h-2 w-2 rounded-full bg-zinc-400",
};

export function MarkGlyph({ outcome, className }: { outcome: AppearanceOutcome; className?: string }) {
  return <span aria-hidden="true" className={cn("block shrink-0", MARK[outcome], className)} />;
}

/** Compact time axis above the matter timeline: one mark per meeting, linked to its entry. */
export function TimelineStrip({ strip }: { strip: Strip }) {
  const present = OUTCOME_ORDER.filter((o) => strip.marks.some((m) => m.outcome === o));
  const meetings = strip.marks.length;
  const toToday = strip.ongoing && strip.end > strip.marks[meetings - 1].date;
  const short = (d: string) => formatDate(d, { year: "numeric", month: "short", day: "numeric" });
  return (
    <figure className="mb-6 rounded-2xl border border-zinc-200 bg-surface px-5 pb-4 pt-4 shadow-sm">
      <figcaption className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-sm">
        <span className="font-medium tabular-nums text-zinc-800">{strip.label}</span>
        {meetings > 1 && <span className="text-xs tabular-nums text-zinc-500">{meetings} meetings</span>}
      </figcaption>
      <div className="relative mx-1.5 mt-4 h-6">
        <div className="absolute inset-x-0 top-1/2 h-px bg-zinc-200" aria-hidden="true" />
        {toToday && (
          <div
            className="absolute right-0 top-1/2 h-px border-t border-dashed border-zinc-400"
            style={{ left: `${strip.marks[meetings - 1].x}%` }}
            aria-hidden="true"
          />
        )}
        {strip.ticks.map((t) => (
          <div key={t.label} className="absolute top-0 h-6 border-l border-zinc-200" style={{ left: `${t.x}%` }} aria-hidden="true">
            <span className="absolute left-1 top-6 text-[10px] tabular-nums text-zinc-400">{t.label}</span>
          </div>
        ))}
        <ol>
          {/* Least decisive first, so a decision is never hidden under a nearby mention. */}
          {[...strip.marks].sort((a, b) => OUTCOME_ORDER.indexOf(b.outcome) - OUTCOME_ORDER.indexOf(a.outcome)).map((m) => (
            <li key={`${m.date}-${m.anchor}`} className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2" style={{ left: `${m.x}%` }}>
              <a
                href={`#${m.anchor}`}
                title={`${short(m.date)}: ${OUTCOME_LABEL[m.outcome]}`}
                aria-label={`${formatDate(m.date)}: ${OUTCOME_LABEL[m.outcome]}`}
                className="-m-1.5 flex items-center justify-center rounded-full p-1.5 hover:bg-zinc-100 focus-visible:outline-2 focus-visible:outline-brand-500"
              >
                <MarkGlyph outcome={m.outcome} className="ring-2 ring-surface" />
              </a>
            </li>
          ))}
        </ol>
      </div>
      <div className={cn("flex text-[11px] tabular-nums text-zinc-500", strip.end === strip.start ? "justify-center" : "justify-between", strip.ticks.length ? "mt-4" : "mt-1")}>
        <span>{short(strip.start)}</span>
        {strip.end !== strip.start && <span>{toToday ? "Today" : short(strip.end)}</span>}
      </div>
      <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1 border-t border-zinc-100 pt-3 text-xs text-zinc-500">
        {present.map((o) => (
          <li key={o} className="flex items-center gap-1.5">
            <MarkGlyph outcome={o} />
            {OUTCOME_LABEL[o]}
          </li>
        ))}
      </ul>
    </figure>
  );
}
