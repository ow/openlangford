import { Link } from "react-router";
import { meetingPath } from "../../lib/paths";
import { formatDate } from "../../lib/utils";
import { normalizeMotionResult, OUTCOME_LABELS } from "../../lib/motion-utils";
import type { LaterMeeting, UpcomingMeeting } from "./hero-section";

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

interface HeroDecisionsProps {
  shortName: string;
  decisions: HeroDecision[];
  upcoming: Array<UpcomingMeeting | LaterMeeting>;
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
      <div className="relative overflow-hidden bg-gradient-to-b from-brand-600 to-brand-800 text-white">
        <div className="relative container mx-auto max-w-6xl px-4 pt-12 pb-28 md:pt-16">
          <h1 className="text-sm font-semibold text-brand-200">What's happening in {shortName}</h1>
          <p className="mt-2 max-w-3xl text-3xl md:text-5xl font-extrabold leading-[1.05] tracking-tight">
            What council decided lately
          </p>

          <ol className="mt-10 grid gap-8 md:grid-cols-3 md:gap-0">
            {lead.map((d, i) => (
              <li
                key={d.id}
                className={i > 0 ? "md:border-l md:border-white/20 md:pl-8" : "md:pr-8"}
              >
                <Link to={meetingPath({ id: d.meetingId, slug: d.meetingSlug })} className="group block">
                  <span className="text-sm font-bold tabular-nums text-brand-300">0{i + 1}</span>
                  <p className="mt-2 text-2xl md:text-3xl font-extrabold leading-tight tracking-tight group-hover:underline decoration-2 underline-offset-4">
                    {d.headline || d.summary}
                  </p>
                  <p className="mt-3 text-sm text-brand-100">
                    {voteLabel(d)}
                    {d.isDivided && <span className="ml-2 rounded-full bg-amber-300 px-2 py-0.5 text-xs font-semibold text-amber-950">Dissent</span>}
                  </p>
                  <p className="mt-1 text-xs text-brand-200">
                    {formatDate(d.meetingDate)} · {d.meetingTitle}
                  </p>
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
        <div className="relative z-10 -mt-24 bg-[linear-gradient(to_bottom,transparent_6rem,white_6rem)]">
          <div className="container mx-auto max-w-6xl px-4">
          <ol className="grid grid-cols-2 gap-3 md:grid-cols-4 md:gap-4">
            {upcoming.map((m, i) => (
              <li key={m.id}>
                <Link
                  to={meetingPath(m)}
                  className="group flex h-full flex-col rounded-2xl bg-white p-4 shadow-lg ring-1 ring-black/5 transition-shadow hover:shadow-xl md:p-5"
                >
                  <span className="flex items-baseline gap-2">
                    <span className="text-3xl font-extrabold tabular-nums tracking-tight text-zinc-900">
                      {formatDate(m.meeting_date, { day: "numeric" })}
                    </span>
                    <span className="text-sm font-semibold text-brand-700">
                      {formatDate(m.meeting_date, { month: "short" })} · {formatDate(m.meeting_date, { weekday: "short" })}
                    </span>
                    {i === 0 && (
                      <span className="ml-auto rounded-full bg-brand-50 px-2 py-0.5 text-[11px] font-semibold text-brand-700">Next</span>
                    )}
                  </span>
                  <span className="mt-2 line-clamp-2 text-sm font-semibold leading-snug text-zinc-800 group-hover:text-brand-700">
                    {m.title}
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
