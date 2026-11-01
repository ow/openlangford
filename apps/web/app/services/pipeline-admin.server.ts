import { summarizeJobUsage, type JobUsageRow } from "../lib/job-usage";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  DONE_STATUSES,
  NOT_HELD_STATUSES,
  todayKey,
} from "../lib/pipeline-status";
import {
  jobTarget,
  resolveFailedJob,
  type Resolution,
  type ResolutionJob,
  type ResolutionMeeting,
} from "../lib/pipeline-resolution";
import { getMunicipality } from "./municipality";

export type PipelineJobType =
  | "preflight"
  | "discover_meetings"
  | "sync_documents"
  | "sync_media"
  | "ingest_meeting"
  | "extract_documents"
  | "embed_content"
  | "diarize_meeting"
  | "regenerate_summary";

export type PipelineDashboardOptions = {
  search?: string;
  page?: number;
  pageSize?: number;
};

/**
 * PostgREST counts the selected row value, so `select("*")` detoasts wide
 * columns (documents.full_text, section embeddings) just to count rows. On a
 * cold cache that exceeded the 8s statement timeout and 500'd the dashboard.
 */
async function exactCount(query: any, applyFilters?: (query: any) => any) {
  let countQuery = query.select("id", {
    count: "exact",
    head: true,
  });
  if (applyFilters) {
    countQuery = applyFilters(countQuery);
  }
  const { count, error } = await countQuery;
  if (error) throw error;
  return count || 0;
}

/**
 * Resolution of every failed job (see lib/pipeline-resolution). Reads the
 * failed jobs, the later successes of the same types, and the meetings they
 * target; the rule itself stays a pure function.
 */
async function getFailureResolutions(
  supabase: SupabaseClient,
  municipalityId: number,
): Promise<Map<number, Resolution>> {
  const resolutions = new Map<number, Resolution>();
  const cols = "id, job_type, status, args, requested_at, finished_at";

  const { data: failed, error } = await supabase
    .from("pipeline_jobs")
    .select(cols)
    .eq("municipality_id", municipalityId)
    .eq("status", "failed")
    .order("id", { ascending: false })
    .limit(1000);
  if (error) throw error;
  const failedJobs = (failed || []) as ResolutionJob[];
  if (failedJobs.length === 0) return resolutions;

  const types = [...new Set(failedJobs.map((job) => job.job_type))];
  const since = failedJobs
    .map((job) => job.requested_at || "")
    .filter(Boolean)
    .sort()[0];
  let successQuery = supabase
    .from("pipeline_jobs")
    .select(cols)
    .eq("municipality_id", municipalityId)
    .eq("status", "succeeded")
    .in("job_type", types)
    .order("requested_at", { ascending: false })
    .limit(1000);
  if (since) successQuery = successQuery.gte("requested_at", since);
  const { data: succeeded, error: succeededError } = await successQuery;
  if (succeededError) throw succeededError;

  const sourceIds = new Set<number>();
  const appMeetingIds = new Set<number>();
  for (const job of failedJobs) {
    const args = (job.args || {}) as Record<string, unknown>;
    if (args.source_meeting_id != null) sourceIds.add(Number(args.source_meeting_id));
    else if (args.meeting_id != null) appMeetingIds.add(Number(args.meeting_id));
  }
  const meetingCols = "id, status, ingested_meeting_id, updated_at";
  const [bySource, byApp] = await Promise.all([
    sourceIds.size
      ? supabase.from("source_meetings").select(meetingCols).in("id", [...sourceIds])
      : { data: [], error: null },
    appMeetingIds.size
      ? supabase
          .from("source_meetings")
          .select(meetingCols)
          .in("ingested_meeting_id", [...appMeetingIds])
      : { data: [], error: null },
  ]);
  if (bySource.error) throw bySource.error;
  if (byApp.error) throw byApp.error;
  const meetingBySource = new Map<number, ResolutionMeeting>(
    (bySource.data || []).map((m: any) => [Number(m.id), m]),
  );
  const meetingByApp = new Map<number, ResolutionMeeting>(
    (byApp.data || []).map((m: any) => [Number(m.ingested_meeting_id), m]),
  );

  for (const job of failedJobs) {
    const target = jobTarget(job);
    const meeting = target
      ? target.startsWith("source:")
        ? meetingBySource.get(Number(target.slice(7)))
        : meetingByApp.get(Number(target.slice(8)))
      : undefined;
    resolutions.set(
      job.id,
      resolveFailedJob(job, (succeeded || []) as ResolutionJob[], meeting),
    );
  }
  return resolutions;
}

export async function getPipelineDashboard(
  supabase: SupabaseClient,
  options: PipelineDashboardOptions = {},
) {
  const municipality = await getMunicipality(supabase);
  const municipalityId = municipality.id;
  const pageSize = options.pageSize || 25;
  const page = Math.max(options.page || 1, 1);
  const search = options.search?.trim();
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  const applySourceFilters = (query: any) => {
    let next = query.eq("municipality_id", municipalityId);
    if (search) {
      const escaped = search.replaceAll("%", "\\%").replaceAll("_", "\\_");
      next = next.or(
        `title.ilike.%${escaped}%,meeting_type.ilike.%${escaped}%,source_id.ilike.%${escaped}%`,
      );
    }
    return next;
  };

  const [
    sourceTotal,
    sourceAwaiting,
    appMeetings,
    appExtractedDocuments,
    appSections,
    jobQueued,
    jobRunning,
    jobSucceeded,
    resolutions,
    activeJobsResult,
    jobsResult,
    sourcesResult,
  ] = await Promise.all([
    exactCount(
      supabase.from("source_meetings"),
      (query) => query.eq("municipality_id", municipalityId),
    ),
    // Awaiting ingest = already happened, not done, not cancelled/postponed.
    // Mirrors the "Waiting for minutes" / "Needs attention" states in the UI.
    exactCount(
      supabase.from("source_meetings"),
      (query) =>
        query
          .eq("municipality_id", municipalityId)
          .not(
            "status",
            "in",
            `(${[...DONE_STATUSES, ...NOT_HELD_STATUSES].join(",")})`,
          )
          .lt("meeting_date", todayKey()),
    ),
    exactCount(supabase.from("meetings"), (query) =>
      query.eq("municipality_id", municipalityId),
    ),
    exactCount(supabase.from("extracted_documents"), (query) =>
      query.eq("municipality_id", municipalityId),
    ),
    exactCount(
      supabase.from("document_sections"),
      (query) => query.eq("municipality_id", municipalityId),
    ),
    exactCount(supabase.from("pipeline_jobs"), (query) =>
      query.eq("municipality_id", municipalityId).eq("status", "queued"),
    ),
    exactCount(supabase.from("pipeline_jobs"), (query) =>
      query.eq("municipality_id", municipalityId).eq("status", "running"),
    ),
    exactCount(supabase.from("pipeline_jobs"), (query) =>
      query.eq("municipality_id", municipalityId).eq("status", "succeeded"),
    ),
    getFailureResolutions(supabase, municipalityId),
    supabase
      .from("pipeline_jobs")
      .select("*")
      .eq("municipality_id", municipalityId)
      .in("status", ["running", "queued"])
      .order("priority", { ascending: false })
      .order("requested_at", { ascending: true })
      .limit(25),
    supabase
      .from("pipeline_jobs")
      .select("*")
      .eq("municipality_id", municipalityId)
      .order("requested_at", { ascending: false })
      .limit(50),
    applySourceFilters(
      supabase
        .from("source_meetings")
        .select(
          "id, source_id, title, meeting_type, meeting_date, status, archive_path, video_url, ingested_meeting_id, last_seen_at, updated_at",
          { count: "exact" },
        ),
    )
      .order("meeting_date", { ascending: false })
      .order("id", { ascending: false })
      .range(from, to),
  ]);

  if (activeJobsResult.error) throw activeJobsResult.error;
  if (jobsResult.error) throw jobsResult.error;
  if (sourcesResult.error) throw sourcesResult.error;

  const jobStatusRank: Record<string, number> = {
    running: 0,
    queued: 1,
    failed: 2,
    cancelled: 3,
    succeeded: 4,
  };
  const jobsById = new Map<number, any>();
  for (const job of activeJobsResult.data || []) jobsById.set(job.id, job);
  for (const job of jobsResult.data || []) jobsById.set(job.id, job);
  const isResolved = (job: any) => {
    const resolution = resolutions.get(job.id);
    return Boolean(resolution?.resolved);
  };
  for (const job of jobsById.values()) {
    const resolution = resolutions.get(job.id);
    if (resolution?.resolved) {
      job.resolved = true;
      job.resolved_reason = resolution.reason;
    }
  }
  // Resolved failures are history: rank them with the other finished jobs.
  const jobRank = (job: any) =>
    job.status === "failed" && isResolved(job)
      ? jobStatusRank.succeeded
      : (jobStatusRank[job.status] ?? 99);
  const jobs = [...jobsById.values()]
    .sort((a: any, b: any) => {
      const rankDelta = jobRank(a) - jobRank(b);
      if (rankDelta !== 0) return rankDelta;
      const aTime = new Date(a.requested_at || 0).getTime();
      const bTime = new Date(b.requested_at || 0).getTime();
      return bTime - aTime;
    })
    .slice(0, 10);

  const jobIds = jobs.map((job) => job.id);
  const events =
    jobIds.length > 0
      ? await supabase
          .from("pipeline_run_events")
          .select("id, job_id, level, message, data, created_at")
          .in("job_id", jobIds)
          .order("created_at", { ascending: false })
          .limit(20)
      : { data: [], error: null };

  if (events.error) throw events.error;

  // Tokens and estimated cost per job (usage recorded since jobs started carrying their id).
  const usageResult = jobIds.length
    ? await supabase.from("ai_usage_by_job").select("*").in("pipeline_job_id", jobIds)
    : { data: [] as JobUsageRow[], error: null };
  if (usageResult.error) console.error("Error fetching job usage:", usageResult.error);
  for (const job of jobs) {
    job.usage = summarizeJobUsage(((usageResult.data || []) as JobUsageRow[]).filter((row) => row.pipeline_job_id === job.id));
  }

  const ingestedMeetingIds = (sourcesResult.data || [])
    .map((meeting: any) => meeting.ingested_meeting_id)
    .filter(Boolean);
  const readinessByMeetingId = new Map<
    number,
    { documentCount: number; sectionCount: number }
  >();

  if (ingestedMeetingIds.length > 0) {
    // Count sections in the database: fetching section rows hit PostgREST's
    // 1,000-row cap and silently undercounted busy pages.
    const { data: meetings, error: readinessError } = await supabase
      .from("meetings")
      .select("id, documents(id, document_sections(count))")
      .in("id", ingestedMeetingIds);
    if (readinessError) throw readinessError;

    for (const meeting of meetings || []) {
      const docs = (meeting as any).documents || [];
      readinessByMeetingId.set(meeting.id, {
        documentCount: docs.length,
        sectionCount: docs.reduce(
          (sum: number, doc: any) => sum + (doc.document_sections?.[0]?.count || 0),
          0,
        ),
      });
    }
  }

  const sourceIds = (sourcesResult.data || []).map((meeting: any) => meeting.id);
  const latestJobBySourceId = new Map<number, any>();
  if (sourceIds.length > 0) {
    const { data: sourceJobs, error: sourceJobsError } = await supabase
      .from("pipeline_jobs")
      .select("id, job_type, status, args, requested_at, started_at, finished_at, locked_at, last_error")
      .eq("municipality_id", municipalityId)
      .order("requested_at", { ascending: false })
      .limit(250);
    if (sourceJobsError) throw sourceJobsError;

    const doneSourceIds = new Set<number>(
      (sourcesResult.data || [])
        .filter(
          (meeting: any) =>
            meeting.ingested_meeting_id &&
            (DONE_STATUSES as readonly string[]).includes(meeting.status),
        )
        .map((meeting: any) => meeting.id),
    );
    const mutedFallback = new Map<number, any>();
    for (const job of sourceJobs || []) {
      const sourceMeetingId = Number((job.args as any)?.source_meeting_id);
      if (!sourceIds.includes(sourceMeetingId)) continue;
      const resolution = resolutions.get(job.id);
      if (resolution?.resolved) {
        (job as any).resolved = true;
        (job as any).resolved_reason = resolution.reason;
        // A Done meeting should not lead with an old, resolved failure:
        // show its latest successful job instead.
        if (doneSourceIds.has(sourceMeetingId)) {
          if (!mutedFallback.has(sourceMeetingId)) {
            mutedFallback.set(sourceMeetingId, job);
          }
          continue;
        }
      }
      if (!latestJobBySourceId.has(sourceMeetingId)) {
        latestJobBySourceId.set(sourceMeetingId, job);
      }
    }
    // Done meetings with no successful job on record keep the resolved failure (shown muted).
    for (const [sourceMeetingId, job] of mutedFallback) {
      if (!latestJobBySourceId.has(sourceMeetingId)) {
        latestJobBySourceId.set(sourceMeetingId, job);
      }
    }
  }

  const sourceMeetings = (sourcesResult.data || []).map((meeting: any) => {
    const readiness = meeting.ingested_meeting_id
      ? readinessByMeetingId.get(meeting.ingested_meeting_id)
      : null;
    return {
      ...meeting,
      document_count: readiness?.documentCount || 0,
      section_count: readiness?.sectionCount || 0,
      latest_job: latestJobBySourceId.get(meeting.id) || null,
    };
  });

  return {
    municipality,
    counts: {
      sourceTotal,
      sourcePendingIngest: sourceAwaiting,
      appMeetings,
      appExtractedDocuments,
      appSections,
      jobQueued,
      jobRunning,
      jobSucceeded,
      jobFailed: [...resolutions.values()].filter((r) => !r.resolved).length,
      jobFailedResolved: [...resolutions.values()].filter((r) => r.resolved)
        .length,
    },
    jobs,
    sourceMeetings,
    sourceMeetingsPage: {
      page,
      pageSize,
      total: sourcesResult.count || 0,
      search: search || "",
      totalPages: Math.max(Math.ceil((sourcesResult.count || 0) / pageSize), 1),
    },
    events: events.data || [],
  };
}

export async function getPipelineJobDetail(
  supabase: SupabaseClient,
  jobId: string,
) {
  const municipality = await getMunicipality(supabase);
  const { data: job, error: jobError } = await supabase
    .from("pipeline_jobs")
    .select("*")
    .eq("id", jobId)
    .eq("municipality_id", municipality.id)
    .single();

  if (jobError) throw jobError;

  const { data: events, error: eventsError } = await supabase
    .from("pipeline_run_events")
    .select("id, job_id, level, message, data, created_at")
    .eq("job_id", job.id)
    .order("created_at", { ascending: true });

  if (eventsError) throw eventsError;

  let sourceMeeting = null;
  const sourceMeetingId = (job.args as any)?.source_meeting_id;
  if (sourceMeetingId) {
    const { data, error } = await supabase
      .from("source_meetings")
      .select(
        "id, source_id, title, meeting_type, meeting_date, status, archive_path, video_url, ingested_meeting_id, last_seen_at",
      )
      .eq("id", sourceMeetingId)
      .eq("municipality_id", municipality.id)
      .maybeSingle();
    if (error) throw error;
    sourceMeeting = data;
  }

  const { data: usageRows, error: usageError } = await supabase
    .from("ai_usage_by_job")
    .select("*")
    .eq("pipeline_job_id", job.id);
  if (usageError) console.error("Error fetching job usage:", usageError);

  return {
    municipality,
    job,
    events: events || [],
    sourceMeeting,
    usage: summarizeJobUsage((usageRows || []) as JobUsageRow[]),
  };
}

export async function enqueuePipelineJob(
  supabase: SupabaseClient,
  jobType: PipelineJobType,
  requestedBy: string | undefined,
  args: Record<string, unknown> = {},
) {
  const municipality = await getMunicipality(supabase);
  const { data, error } = await supabase
    .from("pipeline_jobs")
    .insert({
      municipality_id: municipality.id,
      job_type: jobType,
      args,
      requested_by: requestedBy,
      max_attempts: 1,
    })
    .select()
    .single();

  if (error) throw error;
  return data;
}

export async function cancelPipelineJob(
  supabase: SupabaseClient,
  jobId: string,
) {
  const municipality = await getMunicipality(supabase);
  const { data: existing, error: existingError } = await supabase
    .from("pipeline_jobs")
    .select("id, status")
    .eq("id", jobId)
    .eq("municipality_id", municipality.id)
    .single();

  if (existingError) throw existingError;
  if (existing.status !== "queued") {
    throw new Error("Only queued jobs can be cancelled.");
  }

  const { error } = await supabase
    .from("pipeline_jobs")
    .update({
      status: "cancelled",
      finished_at: new Date().toISOString(),
      last_error: null,
    })
    .eq("id", jobId)
    .eq("status", "queued");

  if (error) throw error;
}

export async function retryPipelineJob(
  supabase: SupabaseClient,
  jobId: string,
  requestedBy: string | undefined,
) {
  const municipality = await getMunicipality(supabase);
  const { data: job, error } = await supabase
    .from("pipeline_jobs")
    .select("job_type, args, priority")
    .eq("id", jobId)
    .eq("municipality_id", municipality.id)
    .single();

  if (error) throw error;

  const { data: newJob, error: insertError } = await supabase
    .from("pipeline_jobs")
    .insert({
      municipality_id: municipality.id,
      job_type: job.job_type,
      args: job.args || {},
      priority: job.priority || 0,
      requested_by: requestedBy,
      max_attempts: 1,
    })
    .select()
    .single();

  if (insertError) throw insertError;
  return newJob;
}
