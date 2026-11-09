import type { ReactNode } from "react";
import { cn, formatDate } from "../../lib/utils";
import type { Outcome } from "../../lib/timeline-entry";

/**
 * The frame every timeline shares (an address's chronology, a topic's history): one rail down the whole page with the
 * year labels on it, a dot for each row, and two weights of card. What goes inside a row is each page's own; the
 * frame, the dots and the cards are here, so a change to how a timeline looks is made once.
 */

/** The small pill for a link or a document button. */
export const PILL = "inline-flex items-center gap-1 rounded-full border border-zinc-200 bg-zinc-50 px-2 py-0.5 text-[11px] font-medium text-zinc-600 transition-colors hover:border-brand-200 hover:text-brand-700";

/** A card where something was decided. */
export const DECIDED_CARD = "overflow-hidden rounded-2xl border border-zinc-200 bg-surface shadow-sm";

/** Everything that was not a decision: a faded card, same shape and padding as a decided one, no shadow. */
export const FADED_CARD = "rounded-2xl border border-zinc-200/80 bg-surface/60 px-5 py-3.5";

export const shortDate = (d: string) => formatDate(d, { year: "numeric", month: "short", day: "numeric" });

/** Rows grouped under their year, in the order given (the caller sorts). A row with no date goes under "Undated". */
export function groupByYear<T>(rows: T[], dateOf: (row: T) => string | null | undefined): [string, T[]][] {
  const years = new Map<string, T[]>();
  for (const row of rows) {
    const year = (dateOf(row) || "").slice(0, 4) || "Undated";
    (years.get(year) || years.set(year, []).get(year)!).push(row);
  }
  return [...years.entries()];
}

/**
 * The rail and the years. One rail runs the whole length, through the year labels, and fades out below the last card
 * instead of stopping. On wide screens it hangs in the left margin (the rows indent by 2.5rem and the list pulls back
 * by as much), so the cards share the page's left edge with every other card; on a phone the rows indent instead.
 * Each row is an <li> from RailItem. The `</ol></section>` pair is how the page check knows a year heading is not part
 * of the row before it.
 */
export function YearTimeline<T>({ rows, dateOf, children }: { rows: T[]; dateOf: (row: T) => string | null | undefined; children: (row: T) => ReactNode }) {
  return (
    <div className="relative">
      <span aria-hidden="true" className="absolute -bottom-12 left-[11px] top-3 w-px md:-left-[29px]"
        style={{ background: "linear-gradient(to bottom, var(--color-zinc-200) calc(100% - 5rem), transparent)" }} />
      <div className="space-y-8">
        {groupByYear(rows, dateOf).map(([year, inYear]) => (
          <section key={year} aria-label={year} className="relative">
            <h3 className="mb-4 pl-10 text-lg font-semibold tabular-nums tracking-tight text-zinc-500 md:pl-0">{year}</h3>
            <ol className="relative space-y-5 md:-ml-10">{inYear.map(children)}</ol>
          </section>
        ))}
      </div>
    </div>
  );
}

/** The rail dot: filled, in the outcome's colour, where something was decided; hollow for everything else. */
export function Disc({ outcome, decided = false }: { outcome?: Outcome | null; decided?: boolean }) {
  const tone = outcome?.variant === "success" ? "border-emerald-600 bg-emerald-600"
    : outcome?.variant === "danger" ? "border-red-600 bg-red-600"
    : outcome?.variant === "warning" ? "border-amber-500 bg-amber-500"
    : decided ? "border-brand-600 bg-brand-600"
    : "border-zinc-300 bg-surface";
  return <span className={cn("absolute left-[6px] top-[18px] h-3 w-3 rounded-full border-2", tone)} aria-hidden="true" />;
}

/** One row on the rail: its anchor (timeline-<key>, which the review bar and the page check find it by) and its dot. */
export function RailItem({ id, reviewKey, dot, children }: { id: string; reviewKey?: string | null; dot?: ReactNode; children: ReactNode }) {
  return (
    <li id={`timeline-${id}`} className="relative scroll-mt-24 pl-10" {...(reviewKey ? { "data-review-entry": reviewKey } : {})}>
      {dot}
      {children}
    </li>
  );
}

/** A row that is not a decision: a hollow dot and a faded card around whatever the page puts in it. */
export function FadedRow({ id, reviewKey, children }: { id: string; reviewKey?: string | null; children: ReactNode }) {
  return (
    <RailItem id={id} reviewKey={reviewKey} dot={<Disc />}>
      <div className={FADED_CARD}>{children}</div>
    </RailItem>
  );
}
