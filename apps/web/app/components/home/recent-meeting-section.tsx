import { Link } from "react-router";
import { meetingPath } from "../../lib/paths";
import ReactMarkdown from "react-markdown";
import {
  PlayCircle,
  Calendar,
  Clock,
  CheckCircle2,
  XCircle,
  ArrowRight,
  Flag,
} from "lucide-react";
import { Badge } from "../ui/badge";
import { SectionHeading } from "../ui/section-heading";
import { MeetingSummary } from "../meeting/MeetingSummary";
import { displaySummary, highlightPoints } from "../../lib/meeting-summary";
import { formatDate } from "../../lib/utils";
import { displayTitle } from "../../lib/display-text";
import { normalizeMotionResult } from "../../lib/motion-utils";

interface RecentMeetingSectionProps {
  meeting: any;
  stats: {
    agendaItems: number;
    totalMotions: number;
    motionsPassed: number;
    dividedVotes: number;
    duration: number | null;
  };
  decisions: Array<{ id: number; summary: string; result: string }>;
}

export function RecentMeetingSection({
  meeting,
  stats,
  decisions,
}: RecentMeetingSectionProps) {
  if (!meeting) return null;

  return (
    <section>
      <SectionHeading title="Latest meeting" icon={PlayCircle} href="/meetings" />

      {/* The title's link stretches over the whole card (after:inset-0), so highlight phrases can be their own links. */}
      <article className="relative block bg-surface rounded-2xl border border-zinc-200 shadow-sm overflow-hidden p-6 hover:border-brand-200 hover:shadow-md transition-all group">
        {/* Header — only show the type when the title doesn't already say it */}
        {meeting.type && meeting.type !== meeting.title && (
          <Badge variant="brand" className="mb-2 text-[11px]">
            {meeting.type}
          </Badge>
        )}
        <h3 className="text-xl font-bold tracking-tight text-zinc-900 mb-1 group-hover:text-brand-700 transition-colors">
          <Link
            to={meetingPath(meeting)}
            className="after:absolute after:inset-0 after:content-[''] focus-visible:outline-none focus-visible:after:rounded-2xl focus-visible:after:ring-2 focus-visible:after:ring-brand-600"
          >
            {meeting.title}
          </Link>
        </h3>
        <div className="flex items-center gap-3 text-sm text-zinc-500 mb-4">
          <div className="flex items-center gap-1">
            <Calendar className="h-3.5 w-3.5" />
            {formatDate(meeting.meeting_date)}
          </div>
          {stats.duration != null && stats.duration > 0 && (
            <div className="flex items-center gap-1">
              <Clock className="h-3.5 w-3.5" />
              {Math.floor(stats.duration / 60)}h {stats.duration % 60}m
            </div>
          )}
        </div>

        {/* AI Summary */}
        {displaySummary(meeting) && (
          <MeetingSummary
            summary={displaySummary(meeting)!}
            points={highlightPoints(meeting)}
            itemHref={(id) => meetingPath(meeting, `#item-${id}`)}
            limit={3}
            className="mb-5 text-[15px]"
          />
        )}

        {/* Pledges from a speech at this meeting get their own call-out (meeting page #commitments). */}
        {meeting.commitments && (
          <div className="relative z-10 mb-5 rounded-xl border border-brand-200 bg-brand-50/60 p-4">
            <p className="mb-2.5 flex items-center gap-2 text-xs font-semibold text-brand-800">
              <Flag className="h-3.5 w-3.5 text-brand-600" />
              What the mayor committed to
            </p>
            {meeting.commitments.key?.length > 0 && (
              <ul className="mb-3 grid gap-2 sm:grid-cols-2">
                {meeting.commitments.key.map((c: { text: string }, i: number) => (
                  <li key={i} className="rounded-lg bg-surface px-3 py-2 text-sm font-medium leading-snug text-zinc-900 shadow-xs">
                    {c.text}
                  </li>
                ))}
              </ul>
            )}
            <Link
              to={meetingPath(meeting, "#commitments")}
              className="inline-flex items-center gap-1.5 text-sm font-semibold text-brand-700 hover:text-brand-800"
            >
              All {meeting.commitments.count} from the {displayTitle(meeting.commitments.title).toLowerCase()}
              <ArrowRight className="h-4 w-4" />
            </Link>
          </div>
        )}

        {/* Stats Row */}
        {(stats.agendaItems > 0 || stats.totalMotions > 0) && (
          <div className="flex gap-6 mb-4 pb-4 border-b border-zinc-100">
            {stats.agendaItems > 0 && (
              <div>
                <div className="text-2xl font-bold text-zinc-900">
                  {stats.agendaItems}
                </div>
                <div className="text-xs text-zinc-500">Agenda Items</div>
              </div>
            )}
            {stats.totalMotions > 0 && (
              <div>
                <div className="text-2xl font-bold text-zinc-900">
                  {stats.motionsPassed}
                  <span className="text-sm font-normal text-zinc-400">
                    /{stats.totalMotions}
                  </span>
                </div>
                <div className="text-xs text-zinc-500">Motions Passed</div>
              </div>
            )}
            {stats.dividedVotes > 0 && (
              <div>
                <div className="text-2xl font-bold text-zinc-900">
                  {stats.dividedVotes}
                </div>
                <div className="text-xs text-zinc-500">Divided Votes</div>
              </div>
            )}
          </div>
        )}

        {/* CTA */}
        <div aria-hidden="true" className="inline-flex items-center gap-2 text-sm text-brand-700 font-semibold group-hover:text-brand-700 transition-colors">
          Open meeting
        </div>
      </article>
    </section>
  );
}
