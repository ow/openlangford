import type { SupabaseClient } from "@supabase/supabase-js";
import type { Municipality } from "../lib/types";

/**
 * "Recent updates": meetings in the order the pipeline finished processing them,
 * whatever their meeting date. Built from succeeded pipeline_jobs (admin-only table);
 * only the meeting, the kind of update and the finish time leave this module.
 */
export type RecentUpdateKind = "transcript" | "documents";

export type RecentUpdate = {
  meetingId: number;
  slug: string | null;
  title: string;
  meetingDate: string;
  type: string | null;
  kind: RecentUpdateKind;
  finishedAt: string;
};

const JOB_KINDS: Record<string, RecentUpdateKind> = {
  diarize_meeting: "transcript",
  transcribe_meeting: "transcript",
  ingest_meeting: "documents",
};
const JOB_LIMIT = 1000;
const LOCAL_DAY = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Vancouver", year: "numeric", month: "2-digit", day: "2-digit" });

/** The Langford calendar day (YYYY-MM-DD) a timestamp falls on. */
export function updateDay(timestamp: string): string {
  return LOCAL_DAY.format(new Date(timestamp));
}

type JobRow = {
  job_type: string;
  finished_at: string;
  args: Record<string, unknown> | null;
  result: Record<string, unknown> | null;
};

function jobMeetingId(job: JobRow): number | null {
  const raw = job.args?.meeting_id ?? job.result?.ingested_meeting_id ?? job.result?.meeting_id;
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** A source-only refresh or a skipped ingest changed nothing a reader would notice. */
function jobChangedMeeting(job: JobRow): boolean {
  return job.result?.source_only_refresh !== true && job.result?.ingestion_skipped !== true;
}

export async function getRecentUpdates(
  supabase: SupabaseClient,
  municipality: Pick<Municipality, "id">,
): Promise<RecentUpdate[]> {
  const { data: jobs, error } = await supabase
    .from("pipeline_jobs")
    .select("job_type, finished_at, args, result")
    .eq("municipality_id", municipality.id)
    .eq("status", "succeeded")
    .in("job_type", Object.keys(JOB_KINDS))
    .not("finished_at", "is", null)
    .order("finished_at", { ascending: false })
    .limit(JOB_LIMIT);
  if (error) throw error;

  // One entry per meeting per day; a transcript outranks a documents-only pass that day.
  const byKey = new Map<string, { meetingId: number; kind: RecentUpdateKind; finishedAt: string }>();
  for (const job of (jobs ?? []) as JobRow[]) {
    const meetingId = jobMeetingId(job);
    if (!meetingId || !jobChangedMeeting(job)) continue;
    const kind = JOB_KINDS[job.job_type];
    const key = `${meetingId}:${updateDay(job.finished_at)}`;
    const existing = byKey.get(key);
    if (!existing) byKey.set(key, { meetingId, kind, finishedAt: job.finished_at });
    else if (kind === "transcript" && existing.kind !== "transcript") existing.kind = "transcript";
  }
  if (!byKey.size) return [];

  const ids = [...new Set([...byKey.values()].map((e) => e.meetingId))];
  const meetings = new Map<number, { slug: string | null; title: string; meeting_date: string; type: string | null; status: string | null }>();
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error: meetingsError } = await supabase
      .from("meetings")
      .select("id, slug, title, meeting_date, type, status")
      .eq("municipality_id", municipality.id)
      .in("id", ids.slice(i, i + 200));
    if (meetingsError) throw meetingsError;
    for (const m of data ?? []) meetings.set(m.id, m);
  }

  const updates: RecentUpdate[] = [];
  for (const entry of byKey.values()) {
    const meeting = meetings.get(entry.meetingId);
    if (!meeting || meeting.status === "Cancelled") continue;
    updates.push({
      meetingId: entry.meetingId,
      slug: meeting.slug,
      title: meeting.title,
      meetingDate: meeting.meeting_date,
      type: meeting.type,
      kind: entry.kind,
      finishedAt: entry.finishedAt,
    });
  }
  return updates.sort((a, b) => b.finishedAt.localeCompare(a.finishedAt));
}
