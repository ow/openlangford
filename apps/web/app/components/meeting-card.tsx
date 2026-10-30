import { CalendarProvenance } from "./calendar-provenance";
import { Link } from "react-router";
import { meetingPath } from "../lib/paths";
import type { Meeting } from "../lib/types";
import { formatDate, cn } from "../lib/utils";
import { Badge } from "./ui/badge";
import { ChevronRight, ClipboardList, FileText, Video } from "lucide-react";
import { type TopicName, TOPICS } from "../lib/topic-utils";
import { LinkedPoint, summaryPoints } from "./meeting/MeetingSummary";
import { displaySummary, highlightPoints } from "../lib/meeting-summary";

export interface MeetingStats {
  motion_carried_count: number;
  motion_defeated_count: number;
  motion_other_count: number;
  topics: string[];
  letter_count?: number;
}

interface MeetingCardProps {
  meeting: Meeting;
  stats?: MeetingStats;
}

/** First point of the summary — a one-line preview for lists. */
export function summaryPreview(summary: string) {
  return summaryPoints(summary)[0] || "";
}

function formatDuration(seconds: number) {
  const mins = Math.round(seconds / 60);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h > 0 ? `${h}h ${m.toString().padStart(2, "0")}m` : `${m}m`;
}

/**
 * A single meeting row, designed to sit inside a grouped list
 * (the parent provides the card chrome and dividers).
 */
export function MeetingCard({ meeting, stats }: MeetingCardProps) {
  const today = new Date().toLocaleDateString("en-CA");
  const isPast = meeting.meeting_date < today;
  const hasContent =
    meeting.has_agenda ||
    meeting.agenda_url ||
    meeting.has_transcript ||
    meeting.has_minutes ||
    meeting.video_url;

  const isCancelled = meeting.status === "Cancelled";
  const isProcessing = isPast && !isCancelled && !meeting.summary && !meeting.calendar_source_id;
  const isUpcoming = !isPast && !isCancelled;

  // Only surface the organization when the title doesn't already name it
  const org = meeting.organization?.name;
  const showOrg = !!org && !meeting.title.toLowerCase().includes(org.toLowerCase());

  const topics = (stats?.topics ?? [])
    .filter((t): t is TopicName => (TOPICS as readonly string[]).includes(t) && t !== "General")
    .slice(0, 3);

  const carried = stats?.motion_carried_count ?? 0;
  const defeated = stats?.motion_defeated_count ?? 0;
  const letters = stats?.letter_count ?? 0;

  const sources = [
    { key: "agenda", label: "Agenda", icon: FileText, on: !!meeting.has_agenda },
    { key: "minutes", label: "Minutes", icon: ClipboardList, on: !!meeting.has_minutes },
    { key: "video", label: "Video", icon: Video, on: !!(meeting.has_transcript || meeting.video_url) },
  ].filter((s) => s.on);

  // The whole row opens the meeting through the title's stretched link (after:inset-0), which leaves
  // room for highlight phrases to link straight to their agenda item (#item-{id}).
  const linksToMeeting = hasContent && !meeting.calendar_source_id;
  const firstPoint = highlightPoints(meeting as any)?.[0];

  return (
    <article
      className={cn(
        "relative flex w-full gap-4 px-4 py-4 sm:px-5 transition-colors",
        meeting.summary ? "items-start" : "items-center",
        hasContent && "group hover:bg-zinc-50/80",
      )}
    >
      {/* Date tile */}
      <div
        className={cn(
          "flex w-14 shrink-0 flex-col items-center rounded-xl border py-1.5",
          isUpcoming
            ? "border-brand-200 bg-brand-50 text-brand-800"
            : "border-zinc-200 bg-zinc-50 text-zinc-900",
        )}
      >
        <span
          className={cn(
            "text-[10px] font-semibold uppercase tracking-wider",
            isUpcoming ? "text-brand-700" : "text-zinc-500",
          )}
        >
          {formatDate(meeting.meeting_date, { weekday: "short" })}
        </span>
        <span className="text-xl font-bold leading-6 tabular-nums">
          {formatDate(meeting.meeting_date, { day: "numeric" })}
        </span>
      </div>

      {/* Main */}
      <div className={cn("min-w-0 flex-1", meeting.summary && "pt-0.5")}>
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <h3
            className={cn(
              "text-[15px] font-semibold leading-snug text-zinc-900 group-hover:text-brand-700 transition-colors",
              isCancelled && "text-zinc-500 line-through",
            )}
          >
            {meeting.calendar_source_id ? (
              <Link to={meetingPath(meeting)} className="hover:underline">{meeting.title}</Link>
            ) : linksToMeeting ? (
              <Link
                to={meetingPath(meeting)}
                className="after:absolute after:inset-0 after:content-[''] focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-inset focus-visible:after:ring-brand-600"
              >
                {meeting.title}
              </Link>
            ) : (
              meeting.title
            )}
          </h3>
          {showOrg && <span className="text-sm text-zinc-500">{org}</span>}
          {isUpcoming && !meeting.calendar_source_id && <Badge variant="brand">Upcoming</Badge>}
          {isProcessing && <Badge variant="muted">Summary pending</Badge>}
          {isCancelled && <Badge variant="danger">Cancelled</Badge>}
        </div>

        <CalendarProvenance meeting={meeting} compact />

        {meeting.summary && (
          <p className="mt-1 max-w-[72ch] text-sm leading-relaxed text-zinc-600 line-clamp-2">
            {firstPoint ? (
              <LinkedPoint
                point={firstPoint}
                itemHref={linksToMeeting ? (id) => meetingPath(meeting, `#item-${id}`) : undefined}
              />
            ) : (
              summaryPreview(displaySummary(meeting as any) || meeting.summary)
            )}
          </p>
        )}

        {(topics.length > 0 || carried + defeated > 0 || letters > 0) && (
          <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-zinc-500">
            {carried + defeated > 0 && (
              <span className="font-medium text-zinc-700">
                {carried + defeated} {carried + defeated === 1 ? "motion" : "motions"}
                {defeated > 0 && (
                  <span className="font-normal text-red-700"> · {defeated} defeated</span>
                )}
              </span>
            )}
            {letters > 0 && (
              <span className="tabular-nums">
                {carried + defeated > 0 && <span aria-hidden="true" className="mr-2 text-zinc-300">·</span>}
                {letters} {letters === 1 ? "letter" : "letters"}
              </span>
            )}
            {(carried + defeated > 0 || letters > 0) && topics.length > 0 && (
              <span aria-hidden="true" className="text-zinc-300">|</span>
            )}
            {topics.length > 0 && <span>{topics.join(", ")}</span>}
          </p>
        )}
      </div>

      {/* Meta */}
      <div className={cn("hidden shrink-0 flex-col items-end gap-1.5 sm:flex", meeting.summary && "self-stretch pt-0.5")}>
        <div className="flex items-center gap-1 text-zinc-400" aria-label={`Available: ${sources.map((s) => s.label).join(", ") || "none"}`}>
          {sources.map(({ key, label, icon: Icon }) => (
            <Icon key={key} className="h-4 w-4" aria-hidden="true">
              <title>{label}</title>
            </Icon>
          ))}
          {hasContent && (
            <ChevronRight className="ml-1 h-4 w-4 text-zinc-300 group-hover:text-brand-600" aria-hidden="true" />
          )}
        </div>
        {meeting.video_duration_seconds ? (
          <span className="text-xs tabular-nums text-zinc-500">
            {formatDuration(meeting.video_duration_seconds)}
          </span>
        ) : null}
      </div>
    </article>
  );
}
