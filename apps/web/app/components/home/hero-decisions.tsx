import { Link } from "react-router";
import { meetingPath } from "../../lib/paths";
import { formatDate } from "../../lib/utils";
import { normalizeMotionResult, OUTCOME_LABELS } from "../../lib/motion-utils";
import type { LaterMeeting, UpcomingMeeting } from "./hero-section";

export interface HeroDecision {
  id: number;
  summary: string;
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
    <div className="relative overflow-hidden bg-gradient-to-b from-brand-600 to-brand-800 text-white">
      <div className="relative container mx-auto max-w-6xl px-4 pt-12 md:pt-16">
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
                <p className="mt-2 text-xl md:text-2xl font-bold leading-snug group-hover:underline decoration-2 underline-offset-4">
                  {d.summary}
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
      </div>

      {upcoming.length > 0 && (
        <div className="relative mt-12 bg-black/15">
          <div className="container mx-auto flex max-w-6xl flex-col gap-3 px-4 py-4 md:flex-row md:items-center md:gap-8">
            <p className="shrink-0 text-xs font-semibold uppercase tracking-wider text-brand-200">Coming up</p>
            <ul className="flex flex-1 flex-wrap gap-x-8 gap-y-2 text-sm">
              {upcoming.map((m) => (
                <li key={m.id}>
                  <Link to={meetingPath(m)} className="group inline-flex items-baseline gap-2">
                    <span className="font-semibold tabular-nums text-brand-200">
                      {formatDate(m.meeting_date, { month: "short", day: "numeric" })}
                    </span>
                    <span className="text-white group-hover:underline underline-offset-4">{m.title}</span>
                  </Link>
                </li>
              ))}
            </ul>
            <Link to="/meetings" className="shrink-0 text-sm font-semibold text-brand-100 hover:text-white">
              Calendar
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
