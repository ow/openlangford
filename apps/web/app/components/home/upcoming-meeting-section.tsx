import { CalendarProvenance } from "../calendar-provenance";
import { Link } from "react-router";
import { meetingPath } from "../../lib/paths";
import { Calendar, MapPin, Video, Clock } from "lucide-react";
import { Badge } from "../ui/badge";
import { SectionHeading } from "../ui/section-heading";
import { cn, formatDate } from "../../lib/utils";
import type { AttendanceInfo } from "../../lib/attendance";

interface AgendaItem {
  title: string;
  category: string;
  summary: string | null;
}

interface UpcomingMeetingSectionProps {
  meeting: {
    id: number;
    calendar_source_id?: number | null;
    status?: string;
    meta?: any;
    title: string;
    meeting_date: string;
    type?: string;
    has_agenda?: boolean;
    agendaPreview: AgendaItem[];
    organizations?: { name: string };
    attendanceInfo?: AttendanceInfo | null;
  } | null;
  inverse?: boolean;
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

export function UpcomingMeetingSection({
  meeting,
  inverse = false,
}: UpcomingMeetingSectionProps) {
  return (
    <section>
      <SectionHeading title="Next event" icon={Calendar} href="/meetings" linkLabel="Calendar" inverse={inverse} />

      {!meeting ? (
        <div className={cn("rounded-2xl border border-dashed px-4 py-5", inverse ? "border-white/30 bg-white/10" : "border-zinc-300 bg-white/60")}>
          <p className={cn("text-sm font-semibold", inverse ? "text-white" : "text-zinc-700")}>
            Nothing on the calendar yet
          </p>
          <p className={cn("mt-1 text-sm", inverse ? "text-brand-100" : "text-zinc-500")}>
            Upcoming events appear here once scheduled.
          </p>
        </div>
      ) : (
        <article
          className="block bg-white rounded-2xl border border-zinc-200 shadow-sm p-5 hover:border-brand-200 hover:shadow-md transition-all group"
        >
          <p className="text-xs font-semibold text-brand-700 mb-1">
            {formatDate(meeting.meeting_date)}
          </p>
          <h3 className="text-lg font-bold text-zinc-900 mb-1 group-hover:text-brand-700 transition-colors">
            <Link to={meetingPath(meeting)} className="hover:underline">{meeting.title}</Link>
          </h3>

          {meeting.attendanceInfo && (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mb-3">
              {meeting.attendanceInfo.startTime && (
                <span className="inline-flex items-center gap-1 text-xs text-zinc-500">
                  <Clock className="h-3 w-3" />
                  {meeting.attendanceInfo.startTime}
                </span>
              )}
              <span className="inline-flex items-center gap-1 text-xs text-zinc-500">
                <MapPin className="h-3 w-3" />
                {meeting.attendanceInfo.venue}
              </span>
              {meeting.attendanceInfo.watchLink && (
                <span
                  className="inline-flex items-center gap-1 text-xs text-brand-600"
                  onClick={(e) => e.stopPropagation()}
                >
                  <Video className="h-3 w-3" />
                  <a
                    href={meeting.attendanceInfo.watchLink}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="hover:underline"
                  >
                    {meeting.attendanceInfo.watchLabel || "Watch online"}
                  </a>
                </span>
              )}
            </div>
          )}

          {!meeting.attendanceInfo && <div className="mb-2" />}

          {meeting.agendaPreview?.length > 0 ? (
            <div className="border-t border-zinc-100 pt-3">
              <h4 className="text-xs font-semibold text-zinc-500 mb-2">
                On the agenda
              </h4>
              <div className="space-y-3">
                {meeting.agendaPreview.map((item, i) => {
                  const cleaned = cleanAgendaTitle(item.title);
                  const displayText = item.summary || cleaned || item.title;
                  return (
                    <div key={i} className="flex items-start gap-3">
                      <Badge
                        variant="secondary"
                        className="text-[10px] shrink-0 mt-0.5"
                      >
                        {item.category}
                      </Badge>
                      <p className="text-sm text-zinc-600 line-clamp-2">
                        {displayText}
                      </p>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : (
            !meeting.calendar_source_id && !meeting.has_agenda && (
              <p className="text-xs text-zinc-400 italic border-t border-zinc-100 pt-3">
                Agenda not yet available
              </p>
            )
          )}

          <CalendarProvenance meeting={meeting} compact />
          <Link to={meetingPath(meeting)} className="mt-4 inline-flex items-center gap-1 text-sm text-brand-600 font-semibold hover:underline">
            View event
          </Link>
        </article>
      )}
    </section>
  );
}
