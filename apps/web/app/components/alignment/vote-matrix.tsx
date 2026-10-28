import { useMemo, useState, type CSSProperties } from "react";
import { Link } from "react-router";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn, formatDate } from "../../lib/utils";
import { meetingPath } from "../../lib/paths";
import { personPath } from "../../lib/people-paths";
import { buildVoteMatrix, columnPage, type ContestedMotion, type MatrixCell } from "../../lib/vote-matrix";

const PAGE = 60;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const HATCH = { backgroundImage: "repeating-linear-gradient(135deg, var(--color-zinc-500) 0 1.5px, transparent 1.5px 4px)" };

/** Teal ✓ vs amber ✕: distinct in hue, lightness and glyph, so it survives colour-blindness. */
const CELL: Record<MatrixCell, { className: string; glyph: string; label: string; style?: CSSProperties }> = {
  yes: { className: "bg-brand-500 text-white", glyph: "✓", label: "Yes" },
  no: { className: "bg-amber-500 text-black/75", glyph: "✕", label: "No" },
  absent: { className: "bg-zinc-200 text-zinc-500", glyph: "·", label: "Absent or no record" },
  recused: { className: "border border-zinc-300 bg-surface", glyph: "", label: "Recused", style: HATCH },
  off: { className: "", glyph: "", label: "Not on council" },
};

function Swatch({ cell }: { cell: MatrixCell }) {
  const c = CELL[cell];
  return (
    <span aria-hidden="true" style={c.style} className={cn("flex h-4 w-4 items-center justify-center rounded-[3px] text-[10px] font-bold leading-none", c.className)}>
      {c.glyph}
    </span>
  );
}

export function VoteMatrix({
  motions,
  members,
  start,
  end,
  servedOn,
  focusedPersonId,
}: {
  motions: ContestedMotion[];
  members: { id: number; name: string; slug?: string | null }[];
  start: string;
  end: string;
  servedOn: (personId: number, date: string) => boolean;
  focusedPersonId?: number | null;
}) {
  const { columns, rows } = useMemo(
    () => buildVoteMatrix(motions, members, { start, end, servedOn }),
    [motions, members, start, end, servedOn],
  );
  const [page, setPage] = useState(0);
  const view = columnPage(columns.length, PAGE, page);
  const shown = columns.slice(view.from, view.to);
  const months = shown.reduce<{ key: string; label: string; span: number }[]>((acc, m) => {
    const key = m.date.slice(0, 7);
    const last = acc[acc.length - 1];
    if (last?.key === key) last.span++;
    else acc.push({ key, label: "", span: 1 });
    return acc;
  }, []);
  // Months with a single column are too narrow to label; the next labelled month carries the year.
  let labelledYear = "";
  for (const m of months) {
    if (m.span < 2) continue;
    const year = m.key.slice(0, 4);
    m.label = `${MONTHS[+m.key.slice(5, 7) - 1]}${year !== labelledYear ? ` ${year}` : ""}`;
    labelledYear = year;
  }
  const short = (d: string) => formatDate(d, { year: "numeric", month: "short", day: "numeric" });

  if (!columns.length) {
    return (
      <div className="rounded-2xl border border-dashed border-zinc-300 bg-surface/60 p-5 text-sm text-zinc-500">
        No split votes with individual records this term.
      </div>
    );
  }

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-xs text-zinc-500">
        <span className="tabular-nums">
          {view.pages > 1
            ? `Motions ${view.from + 1}–${view.to} of ${columns.length}, oldest to newest`
            : `${columns.length} split ${columns.length === 1 ? "vote" : "votes"}, oldest to newest`}
        </span>
        {view.pages > 1 && (
          <span className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setPage(view.page + 1)}
              disabled={view.page >= view.pages - 1}
              className="inline-flex items-center gap-0.5 rounded-md px-2 py-1 font-medium text-brand-700 hover:bg-zinc-100 disabled:text-zinc-300 disabled:hover:bg-transparent"
            >
              <ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" /> Earlier
            </button>
            <button
              type="button"
              onClick={() => setPage(view.page - 1)}
              disabled={view.page === 0}
              className="inline-flex items-center gap-0.5 rounded-md px-2 py-1 font-medium text-brand-700 hover:bg-zinc-100 disabled:text-zinc-300 disabled:hover:bg-transparent"
            >
              Later <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </span>
        )}
      </div>
      <div className="overflow-x-auto rounded-2xl border border-zinc-200 bg-surface shadow-sm">
        <table className="border-separate border-spacing-0 text-xs">
          <caption className="sr-only">Individual votes on split motions</caption>
          <thead>
            <tr>
              <th scope="col" rowSpan={2} className="sticky left-0 z-10 bg-surface px-4 pb-1 pt-3 text-left align-bottom font-medium text-zinc-500">
                Member
              </th>
              {months.map((m) => (
                <th key={m.key} colSpan={m.span} scope="colgroup" className="whitespace-nowrap border-l border-zinc-100 px-1 pt-3 text-left font-medium text-zinc-400 first:border-l-0">
                  {m.label}
                </th>
              ))}
              <th scope="col" rowSpan={2} className="px-3 pb-1 pt-3 text-right align-bottom font-medium text-zinc-500">
                Against
              </th>
            </tr>
            <tr>
              {shown.map((m) => (
                <th key={m.id} scope="col" className="p-0 pb-1">
                  <Link
                    to={meetingPath({ id: m.meetingId, slug: m.meetingSlug })}
                    title={`${short(m.date)}: ${m.summary}${m.result ? ` (${m.result.toLowerCase()})` : ""}`}
                    aria-label={`${short(m.date)}: ${m.summary}`}
                    className="group mx-auto flex h-5 w-5 items-end justify-center"
                  >
                    <span className="h-2.5 w-0.5 rounded-full bg-zinc-300 group-hover:h-4 group-hover:bg-brand-500" />
                  </Link>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map(({ member, cells, no, cast }) => {
              const focused = member.id === focusedPersonId;
              return (
                <tr key={member.id} className={cn(focused && "bg-brand-50/60")}>
                  <th
                    scope="row"
                    className={cn(
                      "sticky left-0 z-10 max-w-52 truncate whitespace-nowrap border-t border-zinc-100 px-4 py-1 text-left text-sm font-medium text-zinc-800",
                      focused ? "bg-brand-50" : "bg-surface",
                    )}
                  >
                    <Link to={personPath(member)} className="hover:text-brand-700">
                      {member.name}
                    </Link>
                  </th>
                  {cells.slice(view.from, view.to).map((cell, i) => {
                    const m = shown[i];
                    const c = CELL[cell];
                    return (
                      <td key={m.id} className="border-t border-zinc-100 px-px py-1">
                        <span
                          title={`${member.name}: ${c.label} · ${short(m.date)}: ${m.summary}`}
                          style={c.style}
                          className={cn(
                            "mx-auto flex h-5 w-4 items-center justify-center rounded-[3px] text-[10px] font-bold leading-none",
                            c.className,
                          )}
                        >
                          <span aria-hidden="true">{c.glyph}</span>
                          <span className="sr-only">{c.label}</span>
                        </span>
                      </td>
                    );
                  })}
                  <td className="whitespace-nowrap border-t border-zinc-100 px-3 py-1 text-right tabular-nums text-zinc-500">
                    {cast ? `${no} of ${cast}` : "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <ul className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-zinc-500">
        {(["yes", "no", "absent", "recused"] as const).map((cell) => (
          <li key={cell} className="flex items-center gap-1.5">
            <Swatch cell={cell} /> {CELL[cell].label}
          </li>
        ))}
        <li className="flex items-center gap-1.5">
          <span aria-hidden="true" className="h-4 w-4 rounded-[3px] border border-dashed border-zinc-200" /> Not on council
        </li>
      </ul>
    </div>
  );
}
