/**
 * When is a failed pipeline job "resolved"?
 *
 * A failure is history, not a to-do, once the work it was about has since
 * happened. /admin/pipeline only asks for attention on unresolved failures.
 */
import { DONE_STATUSES, NOT_HELD_STATUSES } from "./pipeline-status";

export type ResolutionJob = {
  id: number;
  job_type: string;
  status: string;
  args?: Record<string, unknown> | null;
  requested_at?: string | null;
  finished_at?: string | null;
};

/** The source meeting a job targets, with just what the rule needs. */
export type ResolutionMeeting = {
  status: string;
  ingested_meeting_id?: number | null;
  updated_at?: string | null;
};

export type ResolutionReason =
  | "later_success"
  | "meeting_done"
  | "meeting_not_held";

export type Resolution =
  | { resolved: true; reason: ResolutionReason }
  | { resolved: false };

export const RESOLUTION_LABELS: Record<ResolutionReason, string> = {
  later_success: "A later job for the same meeting succeeded",
  meeting_done: "The meeting has since been ingested",
  meeting_not_held: "The meeting was cancelled or postponed",
};

/**
 * What a job is about: `source_meeting_id` (ingest, sync) or `meeting_id`
 * (transcribe, diarize). Jobs with neither (discover, preflight) have no target.
 */
export function jobTarget(job: Pick<ResolutionJob, "args">): string | null {
  const args = job.args || {};
  const source = args.source_meeting_id;
  if (source != null && source !== "") return `source:${source}`;
  const meeting = args.meeting_id;
  if (meeting != null && meeting !== "") return `meeting:${meeting}`;
  return null;
}

function time(value?: string | null) {
  const ms = value ? Date.parse(value) : NaN;
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Resolved when any of these hold:
 *  (a) a later job of the same type and target succeeded. This also covers a
 *      retry, which is a new job with the same type and args;
 *  (b) the target meeting is done (ingested with a meeting) and the failure
 *      predates the meeting's latest update;
 *  (c) the target meeting was cancelled or postponed, so nothing is owed.
 * Only failed jobs can be resolved.
 */
export function resolveFailedJob(
  job: ResolutionJob,
  laterCandidates: ResolutionJob[],
  meeting?: ResolutionMeeting | null,
): Resolution {
  if (job.status !== "failed") return { resolved: false };

  const target = jobTarget(job);
  const failedAt = time(job.finished_at) ?? time(job.requested_at);
  const requestedAt = time(job.requested_at);

  const retried = laterCandidates.some((other) => {
    if (other.id === job.id || other.status !== "succeeded") return false;
    if (other.job_type !== job.job_type || jobTarget(other) !== target) {
      return false;
    }
    const otherAt = time(other.requested_at);
    return otherAt != null && requestedAt != null
      ? otherAt > requestedAt
      : other.id > job.id;
  });
  if (retried) return { resolved: true, reason: "later_success" };

  if (meeting) {
    if ((NOT_HELD_STATUSES as readonly string[]).includes(meeting.status)) {
      return { resolved: true, reason: "meeting_not_held" };
    }
    const done =
      (DONE_STATUSES as readonly string[]).includes(meeting.status) &&
      Boolean(meeting.ingested_meeting_id);
    const updatedAt = time(meeting.updated_at);
    if (done && failedAt != null && updatedAt != null && failedAt < updatedAt) {
      return { resolved: true, reason: "meeting_done" };
    }
  }
  return { resolved: false };
}
