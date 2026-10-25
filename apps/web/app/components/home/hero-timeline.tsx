import { Fragment, useState } from "react";
import { Link } from "react-router";
import { meetingPath } from "../../lib/paths";
import { cn, formatDate } from "../../lib/utils";
import { MeetingSummary } from "../meeting/MeetingSummary";
import { CalendarProvenance } from "../calendar-provenance";
import { cleanAgendaTitle, type LaterMeeting, type UpcomingMeeting } from "./hero-section";

interface PastMeeting {
  id: number;
  slug?: string | null;
  title: string;
  meeting_date: string;
  summary?: string | null;
}

interface HeroTimelineProps {
  shortName: string;
  past: PastMeeting[];
  upcoming: Array<UpcomingMeeting | LaterMeeting>;
}

type Point =
  | { kind: "past"; meeting: PastMeeting }
  | { kind: "upcoming"; meeting: UpcomingMeeting | LaterMeeting };

export function HeroTimeline({ shortName, past, upcoming }: HeroTimelineProps) {
  // Oldest on the left, then today, then the future.
  const pastPoints: Point[] = [...past].reverse().map((meeting) => ({ kind: "past", meeting }));
  const futurePoints: Point[] = upcoming.map((meeting) => ({ kind: "upcoming", meeting }));
  const [selected, setSelected] = useState(pastPoints.length - 1);
  const points = [...pastPoints, ...futurePoints];
  const active = points[selected];

  return (
    <div className="relative overflow-hidden bg-gradient-to-b from-brand-600 to-brand-800 text-white">
      <div className="relative container mx-auto max-w-6xl px-4 py-12 md:py-16">
        <h1 className="text-3xl md:text-5xl font-extrabold tracking-tight">
          What's happening in {shortName}?
        </h1>

        {/* Timeline rail */}
        <div className="mt-10 overflow-x-auto pb-2">
          <ol className="relative flex min-w-[44rem] items-start">
            <span aria-hidden="true" className="absolute left-0 right-0 top-[2.15rem] h-px bg-white/30" />
            {points.map((p, i) => {
              const isPast = p.kind === "past";
              const isActive = i === selected;
              const showToday = i === pastPoints.length;
              return (
                <Fragment key={`${p.kind}-${p.meeting.id}`}>
                {showToday && (
                  <li aria-hidden="true" className="relative flex w-14 flex-none flex-col items-center">
                    <span className="text-xs font-bold uppercase tracking-wider text-amber-200">Today</span>
                    <span className="mt-1.5 h-6 w-0.5 rounded-full bg-amber-300" />
                  </li>
                )}
                <li className="relative flex flex-1 flex-col items-center">
                  <button
                    type="button"
                    onClick={() => setSelected(i)}
                    aria-pressed={isActive}
                    className="group flex w-full flex-col items-center px-2 text-center focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-white"
                  >
                    <span className={cn("text-xs font-semibold tabular-nums", isActive ? "text-white" : "text-brand-200")}>
                      {formatDate(p.meeting.meeting_date, { month: "short", day: "numeric" })}
                    </span>
                    <span
                      className={cn(
                        "mt-2 h-4 w-4 rounded-full border-2 transition-transform",
                        isPast ? "border-white bg-white" : "border-white bg-brand-700",
                        isActive ? "scale-125 ring-4 ring-white/25" : "group-hover:scale-110",
                      )}
                    />
                    <span
                      className={cn(
                        "mt-3 line-clamp-2 text-sm leading-snug",
                        isActive ? "font-semibold text-white" : "text-brand-100 group-hover:text-white",
                      )}
                    >
                      {p.meeting.title}
                    </span>
                  </button>
                </li>
                </Fragment>
              );
            })}
          </ol>
        </div>

        {/* Detail for the selected point */}
        {active && (
          <div className="mt-8 rounded-2xl bg-white p-6 text-zinc-900 shadow-xl md:p-8">
            <p className="text-sm font-semibold text-brand-700">
              {active.kind === "past" ? "Council met" : "Coming up"} ·{" "}
              {formatDate(active.meeting.meeting_date, { weekday: "long", month: "long", day: "numeric" })}
            </p>
            <h2 className="mt-1 text-2xl font-bold tracking-tight">{active.meeting.title}</h2>

            {active.kind === "past" && active.meeting.summary && (
              <MeetingSummary summary={active.meeting.summary} limit={3} className="mt-4 max-w-3xl text-[15px]" />
            )}

            {active.kind === "upcoming" && (
              <>
                {"calendar_source_id" in active.meeting && <CalendarProvenance meeting={active.meeting} compact />}
                {"agendaPreview" in active.meeting && active.meeting.agendaPreview?.length > 0 ? (
                  <ul className="mt-4 space-y-2 text-[15px] text-zinc-700">
                    {active.meeting.agendaPreview.slice(0, 3).map((item, i) => (
                      <li key={i}>{item.summary || cleanAgendaTitle(item.title) || item.title}</li>
                    ))}
                  </ul>
                ) : (
                  !("calendar_source_id" in active.meeting && active.meeting.calendar_source_id) && (
                    <p className="mt-3 text-sm text-zinc-500">The agenda isn't published yet.</p>
                  )
                )}
              </>
            )}

            <Link
              to={meetingPath(active.meeting)}
              className="mt-6 inline-block text-sm font-semibold text-brand-700 hover:underline underline-offset-4"
            >
              {active.kind === "past" ? "Open meeting" : "View event"}
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}
