import { useSiteFlags } from "../../lib/use-site-flags";
import { Link } from "react-router";
import { meetingPath } from "../../lib/paths";
import { formatDate } from "../../lib/utils";
import type { AttendanceInfo } from "../../lib/attendance";
import { CalendarProvenance } from "../calendar-provenance";
import { MeetingSummary } from "../meeting/MeetingSummary";

export interface RecentMeeting {
  meeting: any;
  stats: {
    agendaItems: number;
    totalMotions: number;
    motionsPassed: number;
    dividedVotes: number;
    duration: number | null;
  };
}

export interface UpcomingMeeting {
  id: number;
  slug?: string | null;
  calendar_source_id?: number | null;
  status?: string;
  meta?: any;
  title: string;
  type?: string;
  meeting_date: string;
  has_agenda?: boolean;
  agendaPreview: Array<{ title: string; category: string; summary: string | null }>;
  attendanceInfo?: AttendanceInfo | null;
}

interface HeroSectionProps {
  shortName: string;
  user: any;
  recentMeeting: RecentMeeting;
  upcomingMeeting: UpcomingMeeting | null;
  laterMeetings?: LaterMeeting[];
}

export interface LaterMeeting {
  id: number;
  slug?: string | null;
  title: string;
  meeting_date: string;
}

/**
 * Strip leading item numbers/letters from agenda titles.
 * Handles patterns like "6.a) ", "14.a) 1. ", "7.b) ", "10.c) 1. "
 */
export function cleanAgendaTitle(title: string): string {
  return title
    .replace(/^[\d]+\.?[a-z]?\)\s*(\d+\.?\s*)?/i, "")
    .replace(/^[A-Z]\)\s*/i, "")
    .replace(/^[\d]+\.\s*/i, "")
    .replace(/^Re:\s*/i, "")
    .replace(/^.*?,\s*Re:\s*/i, "")
    .trim();
}

function plural(n: number, word: string) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

export function HeroSection({ shortName, user, recentMeeting, upcomingMeeting, laterMeetings = [] }: HeroSectionProps) {
  const { signupsEnabled } = useSiteFlags();
  return (
    <div className="relative bg-gradient-to-b from-brand-600 to-brand-700 text-white overflow-hidden">
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        {/* Gradient overlays */}
        <div className="absolute inset-0 bg-gradient-to-b from-brand-600/90 via-brand-700/80 to-brand-800/95" />
        <div className="absolute inset-0 bg-gradient-to-r from-brand-700/60 via-transparent to-brand-700/60" />
      </div>

      <div className="relative container mx-auto max-w-6xl px-4 pt-10 pb-12 md:pt-14 md:pb-16">
        <h1 className="mb-6 text-3xl md:text-4xl font-extrabold tracking-tight md:mb-8">
          What's happening in {shortName}?
        </h1>

        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_22rem] lg:gap-6">
          <LatestMeeting {...recentMeeting} />
          <ComingUp meeting={upcomingMeeting} later={laterMeetings} />
        </div>

        {!user && signupsEnabled && (
          <p className="mt-6 text-sm">
            <Link to="/signup" className="text-brand-100 underline underline-offset-2 hover:text-white">
              Create an account to track what matters to you
            </Link>
          </p>
        )}
      </div>
    </div>
  );
}

function LatestMeeting({ meeting, stats }: RecentMeeting) {
  if (!meeting) {
    return (
      <article className="rounded-2xl bg-white p-6 text-zinc-900 shadow-xl md:p-8">
        <p className="text-sm text-zinc-500">No meetings recorded yet.</p>
      </article>
    );
  }

  const facts = [
    formatDate(meeting.meeting_date),
    stats.duration ? `${Math.floor(stats.duration / 60)}h ${stats.duration % 60}m` : null,
    stats.totalMotions > 0 ? `${stats.motionsPassed} of ${plural(stats.totalMotions, "motion")} passed` : null,
    stats.dividedVotes > 0 ? plural(stats.dividedVotes, "divided vote") : null,
  ].filter(Boolean);

  return (
    <article className="flex flex-col rounded-2xl bg-white p-6 text-zinc-900 shadow-xl md:p-8">
      <p className="text-sm font-semibold text-brand-700">Latest meeting</p>
      <h2 className="mt-1 text-2xl md:text-3xl font-bold leading-tight tracking-tight">
        <Link to={meetingPath(meeting)} className="hover:text-brand-700">
          {meeting.title}
        </Link>
      </h2>
      <p className="mt-2 text-sm text-zinc-500">{facts.join(" · ")}</p>

      {meeting.summary && (
        <MeetingSummary
          summary={meeting.summary}
          limit={3}
          className="mt-5 max-w-2xl text-[15px]"
        />
      )}

      <div className="mt-auto flex flex-wrap items-center gap-x-6 gap-y-3 pt-6 text-sm font-semibold">
        <Link
          to={meetingPath(meeting)}
          className="rounded-full bg-brand-600 px-4 py-2 text-white hover:bg-brand-700"
        >
          Open meeting
        </Link>
        <Link to="/meetings" className="text-brand-700 hover:underline underline-offset-4">
          All meetings
        </Link>
      </div>
    </article>
  );
}

export function ComingUp({ meeting, later = [] }: { meeting: UpcomingMeeting | null; later?: LaterMeeting[] }) {
  return (
    <article className="flex flex-col rounded-2xl bg-white p-6 text-zinc-900 shadow-xl">
      <p className="text-sm font-semibold text-brand-700">Coming up</p>

      {!meeting ? (
        <p className="mt-3 text-sm text-zinc-500">
          Nothing on the calendar yet. Upcoming events appear here once scheduled.
        </p>
      ) : (
        <>
          <div className="mt-4 flex items-center gap-4">
            <div className="flex w-14 shrink-0 flex-col items-center overflow-hidden rounded-xl bg-white text-center ring-1 ring-zinc-200">
              <span className="w-full bg-brand-600 py-0.5 text-[11px] font-bold uppercase tracking-wide text-white">
                {formatDate(meeting.meeting_date, { month: "short" })}
              </span>
              <span className="py-1 text-2xl font-bold tabular-nums text-zinc-900">
                {formatDate(meeting.meeting_date, { day: "numeric" })}
              </span>
            </div>
            <div className="min-w-0">
              <h2 className="text-lg font-bold leading-snug">
                <Link to={meetingPath(meeting)} className="hover:text-brand-700">
                  {meeting.title}
                </Link>
              </h2>
              <p className="text-sm text-zinc-500">
                {formatDate(meeting.meeting_date, { weekday: "long", month: "long", day: "numeric", year: "numeric" })}
                {meeting.attendanceInfo?.startTime && ` · ${meeting.attendanceInfo.startTime}`}
              </p>
            </div>
          </div>

          {meeting.attendanceInfo?.venue && (
            <p className="mt-4 text-sm text-zinc-600">
              {meeting.attendanceInfo.venue}
              {meeting.attendanceInfo.watchLink && (
                <>
                  {" · "}
                  <a
                    href={meeting.attendanceInfo.watchLink}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-brand-700 hover:underline underline-offset-2"
                  >
                    {meeting.attendanceInfo.watchLabel || "Watch online"}
                  </a>
                </>
              )}
            </p>
          )}

          <CalendarProvenance meeting={meeting} compact />

          {meeting.agendaPreview?.length > 0 && (
            <div className="mt-5 border-t border-zinc-100 pt-4">
              <p className="text-xs font-semibold text-zinc-500">On the agenda</p>
              <ul className="mt-2 space-y-2 text-sm text-zinc-700">
                {meeting.agendaPreview.slice(0, 3).map((item, i) => (
                  <li key={i} className="line-clamp-2">
                    {item.summary || cleanAgendaTitle(item.title) || item.title}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <Link
            to={meetingPath(meeting)}
            className="mt-4 inline-block text-sm font-semibold text-brand-700 underline-offset-4 hover:underline"
          >
            View event
          </Link>

          {later.length > 0 && (
            <ul className="mt-5 space-y-1 border-t border-zinc-100 pt-3">
              {later.map((m) => (
                <li key={m.id}>
                  <Link to={meetingPath(m)} className="group flex items-baseline gap-4 py-1.5 text-sm">
                    <span className="w-14 shrink-0 font-semibold tabular-nums text-brand-700">
                      {formatDate(m.meeting_date, { month: "short", day: "numeric" })}
                    </span>
                    <span className="min-w-0 text-zinc-700 group-hover:text-brand-700">
                      {m.title}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}

          <Link
            to="/meetings"
            className="mt-auto inline-block pt-3 text-sm font-semibold text-brand-700 underline-offset-4 hover:underline"
          >
            Full calendar
          </Link>
        </>
      )}
    </article>
  );
}
