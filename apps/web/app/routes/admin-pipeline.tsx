import { useEffect, useState, type ReactNode } from "react";
import {
  Form,
  Link,
  useActionData,
  useNavigation,
  useRevalidator,
} from "react-router";
import { ChevronDown, Ellipsis } from "lucide-react";
import type { Route } from "./+types/admin-pipeline";
import { requireAdmin } from "../lib/auth.server";
import { getSupabaseAdminClient } from "../lib/supabase.server";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { ButtonGroup } from "../components/ui/button-group";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu";
import { Input } from "../components/ui/input";
import { DetailHeader } from "../components/ui/detail-header";
import { SearchField } from "../components/ui/search-field";
import { cn, formatDate, formatRelativeTime } from "../lib/utils";
import { shortError } from "../lib/pipeline-format";
import {
  enqueuePipelineJob,
  cancelPipelineJob,
  getPipelineDashboard,
  type PipelineJobType,
} from "../services/pipeline-admin.server";
import { formatCost, formatTokens } from "../lib/job-usage";
import {
  RESOLUTION_LABELS,
  type ResolutionReason,
} from "../lib/pipeline-resolution";
import {
  SOURCE_STATE_LABELS,
  SOURCE_STATE_TONES,
  rawStatusLabel,
  sourceMeetingState,
} from "../lib/pipeline-status";
import { getAiUsageDashboard } from "../services/ai-usage-admin.server";
import { AiUsageSection } from "../components/admin/ai-usage-section";
import { DiscordPostsSection } from "../components/admin/discord-posts-section";
import { getDiscordAdmin, postDiscordNow } from "../services/channels/discord-admin.server";
import type { DiscordEnv } from "../../workers/discord-posts";

/** Runtime vars and secrets (never inlined at build time). */
function discordEnv(context: Route.LoaderArgs["context"]): DiscordEnv {
  return ((context as any)?.cloudflare?.env ?? {}) as DiscordEnv;
}

export async function loader({ request, context }: Route.LoaderArgs) {
  await requireAdmin(request);
  const supabase = getSupabaseAdminClient();
  const url = new URL(request.url);
  const page = Number(url.searchParams.get("page") || "1");
  const q = url.searchParams.get("q") || "";
  const [dashboard, aiUsage, discord] = await Promise.all([
    getPipelineDashboard(supabase, {
      page: Number.isFinite(page) ? page : 1,
      search: q,
      pageSize: 25,
    }),
    getAiUsageDashboard(supabase),
    getDiscordAdmin(discordEnv(context), supabase, url.searchParams.get("discord_preview")),
  ]);
  return { ...dashboard, aiUsage, discord };
}

export async function action({ request, context }: Route.ActionArgs) {
  const user = await requireAdmin(request);
  const supabase = getSupabaseAdminClient();
  const formData = await request.formData();
  const jobType = formData.get("job_type") as PipelineJobType | null;
  const intent = formData.get("intent");
  const jobId = formData.get("job_id") as string | null;
  const limitValue = (formData.get("limit") as string | null)?.trim();
  const discoverAll = formData.get("discover_all") === "true" && !limitValue;
  const limit = discoverAll ? undefined : limitValue ? Number(limitValue) : undefined;
  const sourceMeetingId = formData.get("source_meeting_id") as string | null;
  const meetingId = formData.get("meeting_id") as string | null;
  const table = formData.get("table") as string | null;

  if (intent === "discord_post") {
    const slug = (formData.get("discord_slug") as string | null)?.trim();
    if (!slug) return { error: "Missing meeting." };
    const result = await postDiscordNow(discordEnv(context), supabase, slug);
    return result.error ? { error: result.error } : { success: result.success ?? "Posted to Discord." };
  }

  if (intent === "cancel_job") {
    if (!jobId) return { error: "Missing job id." };
    try {
      await cancelPipelineJob(supabase, jobId);
      return { success: `Cancelled job #${jobId}.` };
    } catch (error: any) {
      return { error: error.message || "Failed to cancel job." };
    }
  }

  const supportedJobTypes: PipelineJobType[] = [
    "preflight",
    "discover_meetings",
    "sync_documents",
    "sync_media",
    "ingest_meeting",
    "extract_documents",
    "embed_content",
    "diarize_meeting",
    "regenerate_summary",
  ];

  if (!jobType || !supportedJobTypes.includes(jobType)) {
    return { error: "Unsupported pipeline job type." };
  }

  if (limitValue && (!Number.isInteger(limit) || Number(limit) <= 0)) {
    return { error: "Limit must be a positive whole number." };
  }

  try {
    const args: Record<string, unknown> = {};
    if (limit) args.limit = limit;
    if (sourceMeetingId) args.source_meeting_id = Number(sourceMeetingId);
    if (meetingId) args.meeting_id = Number(meetingId);
    if (table) args.tables = [table];

    const job = await enqueuePipelineJob(
      supabase,
      jobType,
      user.email || user.id,
      args,
    );
    return { success: `Queued ${jobType.replace("_", " ")} job #${job.id}.` };
  } catch (error: any) {
    return { error: error.message || "Failed to queue pipeline job." };
  }
}

type BadgeTone = "success" | "danger" | "warning" | "muted" | "brand";

/** Job status tones. Source meetings use SOURCE_STATE_TONES (lib/pipeline-status). */
const statusTones: Record<string, BadgeTone> = {
  succeeded: "success",
  completed: "success",
  failed: "danger",
  running: "warning",
  queued: "warning",
  cancelled: "muted",
};

function formatStatus(status: string) {
  const text = status.replaceAll("_", " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function StatusBadge({
  status,
  resolvedReason,
  className,
}: {
  status: string;
  /** Set for a failed job that no longer needs attention. */
  resolvedReason?: ResolutionReason;
  className?: string;
}) {
  if (status === "failed" && resolvedReason) {
    return (
      <Badge
        variant="muted"
        className={className}
        title={RESOLUTION_LABELS[resolvedReason]}
      >
        Failed · resolved
      </Badge>
    );
  }
  return (
    <Badge variant={statusTones[status] ?? "muted"} className={className}>
      {formatStatus(status)}
    </Badge>
  );
}

/** A failed job that is still waiting on someone. */
function needsAttention(job: any) {
  return job?.status === "failed" && !job.resolved;
}

function SourceStatusBadge({
  meeting,
  className,
}: {
  meeting: any;
  className?: string;
}) {
  const state = sourceMeetingState(meeting);
  return (
    <Badge
      variant={SOURCE_STATE_TONES[state]}
      className={className}
      title={`Internal status: ${rawStatusLabel(meeting.status)}`}
    >
      {SOURCE_STATE_LABELS[state]}
    </Badge>
  );
}

function formatJobType(jobType: string) {
  return formatStatus(jobType).toLowerCase();
}

function StatMetric({
  label,
  value,
  detail,
  tone = "default",
}: {
  label: string;
  value: number;
  detail: string;
  tone?: "default" | "danger" | "quiet";
}) {
  return (
    <div className="min-w-0 bg-surface px-5 py-4">
      <div className="text-sm font-medium text-zinc-600">{label}</div>
      <div
        className={cn(
          "mt-1 text-3xl font-semibold tabular-nums tracking-tight",
          tone === "danger" && "text-red-700",
          tone === "quiet" && "text-zinc-400",
          tone === "default" && "text-zinc-950",
        )}
      >
        {value.toLocaleString()}
      </div>
      <p className="mt-1 truncate text-xs tabular-nums text-zinc-500">
        {detail}
      </p>
    </div>
  );
}

function SectionHeader({
  id,
  title,
  meta,
  action,
}: {
  id: string;
  title: string;
  meta?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="mb-3 flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
      <div className="flex min-w-0 items-baseline gap-3">
        <h2 id={id} className="text-lg font-semibold text-zinc-900">
          {title}
        </h2>
        {meta && (
          <span className="text-sm tabular-nums text-zinc-500">{meta}</span>
        )}
      </div>
      {action}
    </div>
  );
}

function QueueJobMenu({ isSubmitting }: { isSubmitting: boolean }) {
  return (
    <details className="group relative w-full md:w-auto">
      <summary className="inline-flex h-9 w-full cursor-pointer list-none items-center justify-center gap-2 whitespace-nowrap rounded-md border border-zinc-200 bg-surface px-3 text-sm font-medium text-zinc-800 shadow-xs transition-colors hover:bg-zinc-50 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-brand-500/20 md:w-auto [&::-webkit-details-marker]:hidden">
        Queue job
        <ChevronDown
          className="h-4 w-4 text-zinc-400 transition-transform group-open:rotate-180"
          aria-hidden="true"
        />
      </summary>
      <div className="mt-2 w-full rounded-2xl border border-zinc-200 bg-surface p-4 shadow-lg md:absolute md:right-0 md:z-30 md:w-[400px]">
        <div className="mb-3">
          <div className="text-sm font-semibold text-zinc-900">
            Manual queue
          </div>
          <p className="mt-0.5 text-sm text-zinc-500">
            Use per-meeting ingest for normal processing.
          </p>
        </div>
        <Form method="post" className="divide-y divide-zinc-100">
          <div className="flex items-center justify-between gap-3 py-2.5">
            <div className="text-sm text-zinc-700">Preflight checks</div>
            <Button
              type="submit"
              name="job_type"
              value="preflight"
              variant="outline"
              size="sm"
              disabled={isSubmitting}
            >
              Run
            </Button>
          </div>
          <div className="py-2.5">
            <label
              htmlFor="discover-limit"
              className="mb-1.5 block text-sm text-zinc-700"
            >
              Discover meetings
            </label>
            <div className="flex gap-2">
              <Input
                id="discover-limit"
                name="limit"
                type="number"
                min="1"
                placeholder="Limit (blank for all)"
                className="h-8"
              />
              <input type="hidden" name="discover_all" value="true" />
              <Button
                type="submit"
                name="job_type"
                value="discover_meetings"
                size="sm"
                disabled={isSubmitting}
              >
                Discover
              </Button>
            </div>
          </div>
          <div className="flex items-center justify-between gap-3 py-2.5">
            <div className="text-sm text-zinc-700">Sync documents</div>
            <Button
              type="submit"
              name="job_type"
              value="sync_documents"
              variant="outline"
              size="sm"
              disabled={isSubmitting}
            >
              Sync
            </Button>
          </div>
          <div className="flex items-center justify-between gap-3 pt-2.5">
            <input type="hidden" name="table" value="document_sections" />
            <div className="text-sm text-zinc-700">Embed document sections</div>
            <Button
              type="submit"
              name="job_type"
              value="embed_content"
              variant="outline"
              size="sm"
              disabled={isSubmitting}
            >
              Queue
            </Button>
          </div>
        </Form>
      </div>
    </details>
  );
}

function jobLifecycleSummary(job: any) {
  if (job.status === "running" && job.started_at) {
    return `Started ${formatRelativeTime(job.started_at)}`;
  }
  if (job.status === "queued" && job.requested_at) {
    return `Queued ${formatRelativeTime(job.requested_at)}`;
  }
  if (
    ["succeeded", "failed", "cancelled"].includes(job.status) &&
    job.finished_at
  ) {
    return `Finished ${formatRelativeTime(job.finished_at)}`;
  }
  if (job.requested_at) {
    return `Requested ${formatRelativeTime(job.requested_at)}`;
  }
  return "Unknown time";
}

const card = "rounded-2xl border border-zinc-200 bg-surface shadow-sm";

function workerSummary(counts: any, jobs: any[]) {
  if (counts.jobRunning > 0 || counts.jobQueued > 0) {
    return `${counts.jobRunning.toLocaleString()} running · ${counts.jobQueued.toLocaleString()} queued`;
  }
  const lastFinished = jobs
    .map((job) => job.finished_at)
    .filter(Boolean)
    .sort()
    .at(-1);
  return lastFinished
    ? `Worker idle · last job finished ${formatRelativeTime(lastFinished)}`
    : "Worker idle";
}

function JobRow({ job, isSubmitting }: { job: any; isSubmitting: boolean }) {
  return (
    <li className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-4 gap-y-1 px-4 py-3 sm:grid-cols-[120px_minmax(0,200px)_minmax(0,1fr)_auto] sm:items-baseline">
      <div className="order-2 sm:order-none">
        <StatusBadge status={job.status} resolvedReason={job.resolved ? job.resolved_reason : undefined} />
      </div>
      <div className="order-1 min-w-0 sm:order-none">
        <Link
          to={`/admin/pipeline/jobs/${job.id}`}
          className="text-sm font-medium text-zinc-900 hover:text-brand-700 hover:underline"
        >
          {formatStatus(job.job_type)}
        </Link>
        <div className="text-xs tabular-nums text-zinc-500">
          #{job.id} · {jobLifecycleSummary(job)}
          {job.usage ? (
            <span title={`${formatTokens(job.usage.inputTokens + job.usage.outputTokens)} across ${job.usage.calls} AI calls (estimate)`}>
              {" · "}
              {formatCost(job.usage.costUsd)}
            </span>
          ) : null}
          {job.status === "running" && job.locked_at
            ? ` · heartbeat ${formatRelativeTime(job.locked_at)}`
            : ""}
        </div>
      </div>
      <div className="order-3 col-span-2 min-w-0 sm:order-none sm:col-span-1">
        {job.last_error && (
          <p
            className="line-clamp-2 text-sm text-zinc-600 sm:line-clamp-1"
            title={job.last_error}
          >
            {shortError(job.last_error)}
          </p>
        )}
      </div>
      <div className="order-4 hidden sm:order-none sm:block">
        {job.status === "queued" && (
          <Form method="post">
            <input type="hidden" name="intent" value="cancel_job" />
            <input type="hidden" name="job_id" value={job.id} />
            <Button
              type="submit"
              variant="ghost"
              size="sm"
              className="h-7 text-zinc-600"
              disabled={isSubmitting}
            >
              Cancel
            </Button>
          </Form>
        )}
      </div>
    </li>
  );
}

function LatestJob({ job }: { job: any }) {
  if (!job) return <span className="text-zinc-300">—</span>;
  const failed = needsAttention(job);
  const resolved = job.status === "failed" && job.resolved;
  return (
    <div className="min-w-0">
      <Link
        to={`/admin/pipeline/jobs/${job.id}`}
        title={job.last_error ? shortError(job.last_error) : undefined}
        className={cn(
          "text-sm hover:underline",
          failed
            ? "font-medium text-red-700"
            : resolved
              ? "text-zinc-500"
              : "text-zinc-700 hover:text-brand-700",
        )}
      >
        {resolved ? "Failed · resolved" : formatStatus(job.status)}
        <span className="tabular-nums text-zinc-400"> #{job.id}</span>
      </Link>
      <div className="text-xs text-zinc-500">
        {formatJobType(job.job_type)}
        {job.requested_at ? ` · ${formatRelativeTime(job.requested_at)}` : ""}
      </div>
    </div>
  );
}

function MeetingActions({
  meeting,
  isSubmitting,
}: {
  meeting: any;
  isSubmitting: boolean;
}) {
  const ingested = Boolean(meeting.ingested_meeting_id);
  const menuItems = [
    !ingested && meeting.video_url && { value: "sync_media", label: "Cache media" },
    ingested && { value: "regenerate_summary", label: "Regenerate summary" },
    ingested && { value: "extract_documents", label: "Rerun documents" },
    ingested && meeting.video_url && { value: "diarize_meeting", label: "Rerun audio" },
  ].filter(Boolean) as { value: string; label: string }[];

  return (
    <div className="flex justify-end">
      <ButtonGroup>
        {ingested ? (
          <Button asChild variant="outline" size="sm">
            <Link to={`/meetings/${meeting.ingested_meeting_id}`}>View</Link>
          </Button>
        ) : (
          <Form method="post">
            <input type="hidden" name="source_meeting_id" value={meeting.id} />
            <Button
              type="submit"
              name="job_type"
              value="ingest_meeting"
              variant={meeting.status === "cancelled" ? "outline" : "default"}
              size="sm"
              disabled={isSubmitting}
            >
              Ingest
            </Button>
          </Form>
        )}
        {menuItems.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="icon-sm"
                disabled={isSubmitting}
                aria-label={`More actions for ${meeting.title}`}
              >
                <Ellipsis />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuGroup>
                {menuItems.map((item) => (
                  <Form method="post" key={item.value}>
                    <input
                      type="hidden"
                      name="source_meeting_id"
                      value={meeting.id}
                    />
                    <DropdownMenuItem asChild>
                      <button
                        type="submit"
                        name="job_type"
                        value={item.value}
                        disabled={isSubmitting}
                        className="w-full"
                      >
                        {item.label}
                      </button>
                    </DropdownMenuItem>
                  </Form>
                ))}
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </ButtonGroup>
    </div>
  );
}

function meetingSubtitle(meeting: any) {
  const date = formatDate(meeting.meeting_date, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  return meeting.meeting_type && meeting.meeting_type !== meeting.title
    ? `${date} · ${meeting.meeting_type}`
    : date;
}

function MeetingOutput({ meeting }: { meeting: any }) {
  if (!meeting.ingested_meeting_id) {
    return <span className="text-zinc-400">Not ingested</span>;
  }
  if (meeting.document_count > 0) {
    return (
      <span className="text-zinc-700">
        {meeting.document_count} docs · {meeting.section_count} sections
      </span>
    );
  }
  return <span className="text-zinc-400">No documents yet</span>;
}

export default function AdminPipeline({ loaderData }: Route.ComponentProps) {
  const {
    counts,
    jobs,
    sourceMeetings,
    sourceMeetingsPage,
    events,
    aiUsage,
    discord,
  } = loaderData;
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const revalidator = useRevalidator();
  const isSubmitting = navigation.state === "submitting";
  const [search, setSearch] = useState(sourceMeetingsPage.search ?? "");
  const hasActiveVisibleJob = sourceMeetings.some((meeting: any) =>
    ["queued", "running"].includes(meeting.latest_job?.status),
  );
  const hasActiveWork =
    counts.jobRunning > 0 || counts.jobQueued > 0 || hasActiveVisibleJob;
  const activeJobs = counts.jobRunning + counts.jobQueued;
  const page = sourceMeetingsPage.page;
  const totalPages = sourceMeetingsPage.totalPages;
  const searchParams = new URLSearchParams();
  if (sourceMeetingsPage.search) {
    searchParams.set("q", sourceMeetingsPage.search);
  }
  const pageHref = (nextPage: number) => {
    const params = new URLSearchParams(searchParams);
    params.set("page", String(nextPage));
    return `/admin/pipeline?${params.toString()}`;
  };

  useEffect(() => {
    setSearch(sourceMeetingsPage.search ?? "");
  }, [sourceMeetingsPage.search]);

  useEffect(() => {
    if (!hasActiveWork) return;
    const id = window.setInterval(() => revalidator.revalidate(), 5000);
    return () => window.clearInterval(id);
  }, [hasActiveWork, revalidator]);

  return (
    <div className="min-h-screen bg-zinc-50">
      <div className="container mx-auto max-w-6xl px-4 pt-6 pb-12 md:pt-10">
        <DetailHeader
          back={{ to: "/admin", label: "Admin" }}
          meta={[
            <span key="worker" className="inline-flex items-center gap-2">
              <span
                aria-hidden="true"
                className={cn(
                  "h-2 w-2 rounded-full",
                  activeJobs > 0 ? "animate-pulse bg-amber-500" : "bg-zinc-300",
                )}
              />
              {workerSummary(counts, jobs)}
            </span>,
          ]}
          title="Pipeline"
          actions={<QueueJobMenu isSubmitting={isSubmitting} />}
        />

        {actionData?.success && (
          <p
            role="status"
            className="mb-6 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-2.5 text-sm text-emerald-800"
          >
            {actionData.success}
          </p>
        )}
        {actionData?.error && (
          <p
            role="alert"
            className="mb-6 rounded-xl border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-800"
          >
            {actionData.error}
          </p>
        )}

        <div
          className={cn(
            card,
            "grid grid-cols-2 gap-px overflow-hidden bg-zinc-200 lg:grid-cols-4",
          )}
        >
          <StatMetric
            label="Active jobs"
            value={activeJobs}
            tone={activeJobs > 0 ? "default" : "quiet"}
            detail={`${counts.jobRunning.toLocaleString()} running · ${counts.jobQueued.toLocaleString()} queued`}
          />
          <StatMetric
            label="Needs attention"
            value={counts.jobFailed}
            tone={counts.jobFailed > 0 ? "danger" : "quiet"}
            detail={`${counts.jobFailedResolved.toLocaleString()} resolved failures · ${counts.jobSucceeded.toLocaleString()} succeeded`}
          />
          <StatMetric
            label="Awaiting ingest"
            value={counts.sourcePendingIngest}
            tone={counts.sourcePendingIngest > 0 ? "default" : "quiet"}
            detail={`of ${counts.sourceTotal.toLocaleString()} source meetings`}
          />
          <StatMetric
            label="Searchable documents"
            value={counts.appExtractedDocuments}
            detail={`${counts.appMeetings.toLocaleString()} meetings · ${counts.appSections.toLocaleString()} sections`}
          />
        </div>

        <section aria-labelledby="jobs-heading" className="mt-10">
          <SectionHeader id="jobs-heading" title="Recent jobs" />
          {jobs.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-zinc-300 bg-surface/60 p-5 text-sm text-zinc-500">
              No jobs queued yet.
            </div>
          ) : (
            <ul className={cn(card, "divide-y divide-zinc-100")}>
              {jobs.map((job: any) => (
                <JobRow key={job.id} job={job} isSubmitting={isSubmitting} />
              ))}
            </ul>
          )}

          {events.length > 0 && (
            <details className="group mt-3">
              <summary className="inline-flex cursor-pointer list-none items-center gap-1 text-sm font-medium text-zinc-500 hover:text-brand-700 [&::-webkit-details-marker]:hidden">
                <ChevronDown
                  className="h-4 w-4 -rotate-90 transition-transform group-open:rotate-0"
                  aria-hidden="true"
                />
                Worker output
              </summary>
              <ol className="mt-2 max-h-80 overflow-auto rounded-xl border border-zinc-200 bg-zinc-50 p-3 font-mono text-xs leading-relaxed text-zinc-700">
                {events.map((event: any) => (
                  <li key={event.id} className="flex gap-3">
                    <Link
                      to={`/admin/pipeline/jobs/${event.job_id}`}
                      className="shrink-0 tabular-nums text-zinc-400 hover:text-brand-700"
                    >
                      #{event.job_id}
                    </Link>
                    <span
                      className={cn(
                        "min-w-0 break-words",
                        event.level === "error" && "text-red-700",
                        event.level === "warning" && "text-amber-800",
                      )}
                    >
                      {event.message}
                    </span>
                  </li>
                ))}
              </ol>
            </details>
          )}
        </section>

        <section aria-labelledby="inventory-heading" className="mt-10">
          <SectionHeader
            id="inventory-heading"
            title="Meeting inventory"
            meta={`${sourceMeetingsPage.total.toLocaleString()} upstream`}
            action={
              <Form method="get" className="w-full sm:w-72" role="search">
                <SearchField
                  name="q"
                  value={search}
                  onValueChange={setSearch}
                  placeholder="Search title, type or source ID"
                  aria-label="Search source meetings"
                />
              </Form>
            }
          />

          {sourceMeetings.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-zinc-300 bg-surface/60 p-5 text-sm text-zinc-500">
              {sourceMeetingsPage.search
                ? `No source meetings match "${sourceMeetingsPage.search}".`
                : "No source meetings recorded yet. Queue discovery to populate this list."}
            </div>
          ) : (
            <div className={cn(card, "overflow-hidden")}>
              <ul className="divide-y divide-zinc-100 md:hidden">
                {sourceMeetings.map((meeting: any) => (
                  <li key={meeting.id} className="flex items-start gap-3 px-4 py-3">
                    <div className="min-w-0 flex-1">
                      <div className="font-medium text-zinc-900">
                        {meeting.title}
                      </div>
                      <div className="text-xs tabular-nums text-zinc-500">
                        {meetingSubtitle(meeting)}
                      </div>
                      <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs tabular-nums">
                        <SourceStatusBadge meeting={meeting} />
                        <MeetingOutput meeting={meeting} />
                        {needsAttention(meeting.latest_job) && (
                          <Link
                            to={`/admin/pipeline/jobs/${meeting.latest_job.id}`}
                            className="font-medium text-red-700 hover:underline"
                          >
                            Job failed
                          </Link>
                        )}
                      </div>
                    </div>
                    <MeetingActions meeting={meeting} isSubmitting={isSubmitting} />
                  </li>
                ))}
              </ul>
              <div className="hidden overflow-x-auto md:block">
                <table className="w-full text-sm">
                  <thead className="border-b border-zinc-200 text-left text-xs text-zinc-500">
                    <tr>
                      <th scope="col" className="px-4 py-2.5 font-medium">
                        Meeting
                      </th>
                      <th scope="col" className="px-4 py-2.5 font-medium">
                        Status
                      </th>
                      <th scope="col" className="px-4 py-2.5 font-medium">
                        Output
                      </th>
                      <th scope="col" className="px-4 py-2.5 font-medium">
                        Latest job
                      </th>
                      <th scope="col" className="px-4 py-2.5">
                        <span className="sr-only">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-100">
                    {sourceMeetings.map((meeting: any) => (
                      <tr key={meeting.id} className="align-middle">
                        <td className="min-w-[240px] px-4 py-3">
                          <div className="font-medium text-zinc-900">
                            {meeting.title}
                          </div>
                          <div className="text-xs tabular-nums text-zinc-500">
                            {meetingSubtitle(meeting)}
                          </div>
                        </td>
                        <td className="whitespace-nowrap px-4 py-3">
                          <SourceStatusBadge meeting={meeting} />
                        </td>
                        <td className="whitespace-nowrap px-4 py-3 text-xs tabular-nums">
                          <MeetingOutput meeting={meeting} />
                        </td>
                        <td className="min-w-[150px] px-4 py-3">
                          <LatestJob job={meeting.latest_job} />
                        </td>
                        <td className="px-4 py-3">
                          <MeetingActions
                            meeting={meeting}
                            isSubmitting={isSubmitting}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="flex items-center justify-between gap-3 border-t border-zinc-100 px-4 py-3 text-sm text-zinc-500">
                <div className="tabular-nums">
                  Page {page} of {totalPages}
                  {sourceMeetingsPage.search
                    ? ` for "${sourceMeetingsPage.search}"`
                    : ""}
                </div>
                <div className="flex gap-2">
                  {page <= 1 ? (
                    <Button variant="outline" size="sm" disabled>
                      Previous
                    </Button>
                  ) : (
                    <Button asChild variant="outline" size="sm">
                      <Link to={pageHref(Math.max(page - 1, 1))}>Previous</Link>
                    </Button>
                  )}
                  {page >= totalPages ? (
                    <Button variant="outline" size="sm" disabled>
                      Next
                    </Button>
                  ) : (
                    <Button asChild variant="outline" size="sm">
                      <Link to={pageHref(Math.min(page + 1, totalPages))}>
                        Next
                      </Link>
                    </Button>
                  )}
                </div>
              </div>
            </div>
          )}
        </section>

        <DiscordPostsSection discord={discord} isSubmitting={isSubmitting} />

        <AiUsageSection usage={aiUsage} />
      </div>
    </div>
  );
}
