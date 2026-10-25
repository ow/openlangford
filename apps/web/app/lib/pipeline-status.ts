/**
 * Plain-language state for a source meeting on /admin/pipeline.
 *
 * `source_meetings.status` holds internal pipeline steps (see the lifecycle
 * table at the top of apps/pipeline/pipeline/ops.py). Admins care about the
 * outcome, so we collapse those steps into a handful of states and keep the
 * raw status available as a tooltip.
 */

export type SourceMeetingState =
  | "done"
  | "waiting"
  | "upcoming"
  | "cancelled"
  | "postponed"
  | "attention";

export type SourceMeetingTone = "success" | "danger" | "warning" | "muted" | "brand";

/** Statuses meaning "ingested and has content" (extracted is the legacy name). */
export const DONE_STATUSES = ["ingested", "extracted"] as const;
/** Statuses where the source itself says the meeting did not go ahead. */
export const NOT_HELD_STATUSES = ["cancelled", "postponed"] as const;

/** A meeting still not done this many days after its date is considered stuck. */
export const STUCK_AFTER_DAYS = 45;

export const SOURCE_STATE_LABELS: Record<SourceMeetingState, string> = {
  done: "Done",
  waiting: "Waiting for minutes",
  upcoming: "Upcoming",
  cancelled: "Cancelled",
  postponed: "Postponed",
  attention: "Needs attention",
};

export const SOURCE_STATE_TONES: Record<SourceMeetingState, SourceMeetingTone> = {
  done: "success",
  waiting: "warning",
  upcoming: "muted",
  cancelled: "muted",
  postponed: "muted",
  attention: "danger",
};

/** Today's date (YYYY-MM-DD) in the municipality's zone. */
export function todayKey(now: Date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Vancouver",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

function daysBetween(fromKey: string, toKey: string) {
  return Math.round(
    (Date.parse(`${toKey}T00:00:00Z`) - Date.parse(`${fromKey}T00:00:00Z`)) /
      86_400_000,
  );
}

export function sourceMeetingState(
  meeting: {
    status: string;
    meeting_date: string;
    latest_job?: { status?: string; resolved?: boolean } | null;
  },
  today: string = todayKey(),
): SourceMeetingState {
  const { status } = meeting;
  if (status === "cancelled") return "cancelled";
  if (status === "postponed") return "postponed";
  if ((DONE_STATUSES as readonly string[]).includes(status)) return "done";

  const date = meeting.meeting_date?.slice(0, 10);
  if (!date || date >= today) return "upcoming";

  if (meeting.latest_job?.status === "failed" && !meeting.latest_job.resolved) {
    return "attention";
  }
  if (daysBetween(date, today) > STUCK_AFTER_DAYS) return "attention";
  return "waiting";
}

/** Internal status for the tooltip, e.g. "documents downloaded". */
export function rawStatusLabel(status: string) {
  return status.replaceAll("_", " ");
}
