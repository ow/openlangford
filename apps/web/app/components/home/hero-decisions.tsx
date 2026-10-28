import { Link } from "react-router";
import { meetingPath } from "../../lib/paths";
import { formatDate } from "../../lib/utils";
import { normalizeMotionResult, OUTCOME_LABELS } from "../../lib/motion-utils";

export interface HeroDecision {
  id: number;
  summary: string;
  headline?: string | null;
  result: string;
  meetingId: number;
  meetingSlug?: string | null;
  meetingDate: string;
  meetingTitle: string;
  yesCount: number;
  noCount: number;
  voteCoverage?: string | null;
  isDivided: boolean;
}

export interface HeroEvent {
  id: number;
  slug?: string | null;
  title: string;
  meeting_date: string;
}

interface HeroDecisionsProps {
  shortName: string;
  decisions: HeroDecision[];
  upcoming: HeroEvent[];
}

function voteLabel(d: HeroDecision) {
  const outcome = normalizeMotionResult(d.result);
  const label = outcome ? OUTCOME_LABELS[outcome] : d.result;
  if (d.voteCoverage === "reconstructed_complete" && d.yesCount + d.noCount > 0) {
    return `${label} ${d.yesCount}–${d.noCount}`;
  }
  return label;
}

export function HeroDecisions({ shortName, decisions, upcoming }: HeroDecisionsProps) {
  const lead = decisions.slice(0, 3);
  return (
    <>
      <div className="light-scope relative overflow-hidden bg-gradient-to-b from-brand-600 to-brand-800 text-white">
        <div className="relative container mx-auto max-w-6xl px-4 pt-12 pb-28 md:pt-16">
          <h1 className="text-sm font-semibold text-brand-200">What's happening in {shortName}</h1>
          <p className="mt-2 max-w-3xl text-3xl md:text-5xl font-extrabold leading-[1.05] tracking-tight">
            What council decided lately
          </p>

          <ol className="mt-10 grid gap-8 md:grid-cols-3 md:gap-6 lg:gap-8">
            {lead.map((d, i) => (
              <li key={d.id} className="border-t border-surface/25 pt-5">
                <Link
                  to={meetingPath({ id: d.meetingId, slug: d.meetingSlug })}
                  className="group flex h-full flex-col"
                >
                  <span className="text-sm font-bold tabular-nums text-brand-300">0{i + 1}</span>
                  <p className="mt-2 text-2xl lg:text-3xl font-extrabold leading-tight tracking-tight group-hover:underline decoration-2 underline-offset-4">
                    {d.headline || d.summary}
                  </p>
                  <div className="mt-auto pt-4">
                    <p className="text-sm text-brand-100">
                      {voteLabel(d)}
                      {d.isDivided && <span className="ml-2 rounded-full bg-amber-300 px-2 py-0.5 text-xs font-semibold text-amber-950">Dissent</span>}
                    </p>
                    <p className="mt-1 text-xs text-brand-200">
                      {formatDate(d.meetingDate)} · {d.meetingTitle}
                    </p>
                  </div>
                </Link>
              </li>
            ))}
          </ol>

          {upcoming.length > 0 && (
            <div className="mt-14 flex items-baseline justify-between gap-4">
              <p className="text-xs font-semibold uppercase tracking-wider text-brand-200">Coming up</p>
              <Link to="/meetings" className="text-sm font-semibold text-brand-100 hover:text-white">
                Full calendar
              </Link>
            </div>
          )}
        </div>
      </div>

      {upcoming.length > 0 && (
        // Top of the strip overlaps the teal; the rest blends into the white section below.
        <div className="relative z-10 -mt-24 bg-[linear-gradient(to_bottom,transparent_6rem,var(--color-surface)_6rem)]">
          <div className="container mx-auto max-w-6xl px-4">
          <ol className="grid gap-3 md:grid-cols-3 md:gap-6 lg:gap-8">
            {upcoming.slice(0, 3).map((m, i) => (
              <li key={m.id}>
                <Link
                  to={meetingPath(m)}
                  className="group flex h-full items-center gap-4 rounded-2xl bg-surface p-4 shadow-lg ring-1 ring-black/5 transition-shadow hover:shadow-xl md:p-5"
                >
                  <span className="flex w-14 shrink-0 flex-col items-center rounded-xl bg-brand-50 py-2 text-brand-800">
                    <span className="text-[11px] font-bold uppercase tracking-wide">
                      {formatDate(m.meeting_date, { month: "short" })}
                    </span>
                    <span className="text-2xl font-extrabold leading-none tabular-nums">
                      {formatDate(m.meeting_date, { day: "numeric" })}
                    </span>
                  </span>
                  <span className="min-w-0">
                    <span className="block text-xs font-semibold text-zinc-500">
                      {i === 0 ? "Next · " : ""}
                      {formatDate(m.meeting_date, { weekday: "long" })}
                    </span>
                    <span className="mt-0.5 block line-clamp-2 font-semibold leading-snug text-zinc-900 group-hover:text-brand-700">
                      {m.title}
                    </span>
                  </span>
                </Link>
              </li>
            ))}
          </ol>
          </div>
        </div>
      )}
    </>
  );
}
