import { useSiteFlags } from "../../lib/use-site-flags";
import { Link } from "react-router";
import { meetingPath } from "../../lib/paths";
import { formatDate } from "../../lib/utils";
import type { AttendanceInfo } from "../../lib/attendance";
import { CalendarProvenance } from "../calendar-provenance";
import { MeetingSummary } from "../meeting/MeetingSummary";

interface RecentMeeting {
  meeting: any;
  stats: {
    agendaItems: number;
    totalMotions: number;
    motionsPassed: number;
    dividedVotes: number;
    duration: number | null;
  };
}

interface UpcomingMeeting {
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

interface LaterMeeting {
  id: number;
  slug?: string | null;
  title: string;
  meeting_date: string;
}

/**
 * Strip leading item numbers/letters from agenda titles.
 * Handles patterns like "6.a) ", "14.a) 1. ", "7.b) ", "10.c) 1. "
 */
function cleanAgendaTitle(title: string): string {
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
        <h1 className="sr-only">What's happening in {shortName}</h1>

        <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_20rem] lg:items-start lg:gap-16">
          <LatestMeeting {...recentMeeting} />
          <ComingUp meeting={upcomingMeeting} later={laterMeetings} />
        </div>

        {!user && signupsEnabled && (
          <p className="mt-10 border-t border-white/15 pt-6 text-sm">
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
    return <p className="text-brand-100">No meetings recorded yet.</p>;
  }

  const facts = [
    formatDate(meeting.meeting_date),
    stats.duration ? `${Math.floor(stats.duration / 60)}h ${stats.duration % 60}m` : null,
    stats.totalMotions > 0 ? `${stats.motionsPassed} of ${plural(stats.totalMotions, "motion")} passed` : null,
    stats.dividedVotes > 0 ? plural(stats.dividedVotes, "divided vote") : null,
  ].filter(Boolean);

  return (
    <article>
      <p className="text-xs font-semibold uppercase tracking-wider text-brand-200">Latest meeting</p>
      <h2 className="mt-2 text-3xl md:text-5xl font-extrabold leading-[1.05] tracking-tight">
        <Link to={meetingPath(meeting)} className="hover:underline decoration-2 underline-offset-[6px]">
          {meeting.title}
        </Link>
      </h2>
      <p className="mt-3 text-sm text-brand-100">{facts.join(" · ")}</p>

      {meeting.summary && (
        <MeetingSummary
          summary={meeting.summary}
          limit={3}
          className="mt-6 max-w-2xl space-y-3 text-base text-white/90 [&_li>span:first-child]:bg-brand-300"
        />
      )}

      <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-3 text-sm font-semibold">
        <Link
          to={meetingPath(meeting)}
          className="rounded-full bg-white px-4 py-2 text-brand-800 shadow-sm hover:bg-brand-50"
        >
          Open meeting
        </Link>
        <Link to="/meetings" className="text-brand-100 hover:text-white hover:underline underline-offset-4">
          All meetings
        </Link>
      </div>
    </article>
  );
}

export function ComingUp({ meeting, later = [] }: { meeting: UpcomingMeeting | null; later?: LaterMeeting[] }) {
  return (
    <article className="rounded-2xl bg-white/10 p-6 ring-1 ring-white/15 backdrop-blur-sm">
      <p className="text-xs font-semibold uppercase tracking-wider text-brand-200">Coming up</p>

      {!meeting ? (
        <p className="mt-3 text-sm text-brand-100">
          Nothing on the calendar yet. Upcoming events appear here once scheduled.
        </p>
      ) : (
        <>
          <div className="mt-4 flex items-center gap-4">
            <div className="flex w-14 shrink-0 flex-col items-center overflow-hidden rounded-xl bg-white text-center shadow-sm">
              <span className="w-full bg-brand-100 py-0.5 text-[11px] font-bold uppercase tracking-wide text-brand-800">
                {formatDate(meeting.meeting_date, { month: "short" })}
              </span>
              <span className="py-1 text-2xl font-bold tabular-nums text-zinc-900">
                {formatDate(meeting.meeting_date, { day: "numeric" })}
              </span>
            </div>
            <div className="min-w-0">
              <h2 className="text-lg font-bold leading-snug">
                <Link to={meetingPath(meeting)} className="hover:underline underline-offset-4">
                  {meeting.title}
                </Link>
              </h2>
              <p className="text-sm text-brand-100">
                {formatDate(meeting.meeting_date, { weekday: "long", month: "long", day: "numeric", year: "numeric" })}
                {meeting.attendanceInfo?.startTime && ` · ${meeting.attendanceInfo.startTime}`}
              </p>
            </div>
          </div>

          {meeting.attendanceInfo?.venue && (
            <p className="mt-4 text-sm text-brand-50">
              {meeting.attendanceInfo.venue}
              {meeting.attendanceInfo.watchLink && (
                <>
                  {" · "}
                  <a
                    href={meeting.attendanceInfo.watchLink}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline underline-offset-2 hover:text-white"
                  >
                    {meeting.attendanceInfo.watchLabel || "Watch online"}
                  </a>
                </>
              )}
            </p>
          )}

          <CalendarProvenance meeting={meeting} compact className="mt-4 text-brand-100" />

          {meeting.agendaPreview?.length > 0 && (
            <div className="mt-5 border-t border-white/15 pt-4">
              <p className="text-xs font-semibold text-brand-200">On the agenda</p>
              <ul className="mt-2 space-y-2 text-sm text-white/90">
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
            className="mt-4 inline-block text-sm font-semibold text-white underline-offset-4 hover:underline"
          >
            View event
          </Link>

          {later.length > 0 && (
            <ul className="mt-5 space-y-1 border-t border-white/15 pt-3">
              {later.map((m) => (
                <li key={m.id}>
                  <Link to={meetingPath(m)} className="group flex items-baseline gap-4 py-1.5 text-sm">
                    <span className="w-14 shrink-0 font-semibold tabular-nums text-brand-200">
                      {formatDate(m.meeting_date, { month: "short", day: "numeric" })}
                    </span>
                    <span className="min-w-0 text-white/90 group-hover:text-white group-hover:underline underline-offset-4">
                      {m.title}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}

          <Link
            to="/meetings"
            className="mt-2 inline-block text-sm font-semibold text-brand-100 underline-offset-4 hover:text-white hover:underline"
          >
            Full calendar
          </Link>
        </>
      )}
    </article>
  );
}
