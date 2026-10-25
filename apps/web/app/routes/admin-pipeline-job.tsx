import { useEffect, useRef } from "react";
import {
  Form,
  Link,
  redirect,
  useActionData,
  useNavigation,
  useRevalidator,
} from "react-router";
import type { ReactNode } from "react";
import type { Route } from "./+types/admin-pipeline-job";
import { requireAdmin } from "../lib/auth.server";
import { getSupabaseAdminClient } from "../lib/supabase.server";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { DetailHeader } from "../components/ui/detail-header";
import { cn, formatDate, formatRelativeTime } from "../lib/utils";
import {
  errorDetails,
  formatDateTime,
  formatDuration,
  formatLogTime,
  shortError,
} from "../lib/pipeline-format";
import {
  cancelPipelineJob,
  getPipelineJobDetail,
  retryPipelineJob,
} from "../services/pipeline-admin.server";

export async function loader({ request, params }: Route.LoaderArgs) {
  await requireAdmin(request);
  const supabase = getSupabaseAdminClient();
  return getPipelineJobDetail(supabase, params.id);
}

export async function action({ request, params }: Route.ActionArgs) {
  const user = await requireAdmin(request);
  const supabase = getSupabaseAdminClient();
  const formData = await request.formData();
  const intent = formData.get("intent");

  try {
    if (intent === "cancel") {
      await cancelPipelineJob(supabase, params.id);
      return { success: "Job cancelled." };
    }
    if (intent === "retry") {
      const newJob = await retryPipelineJob(
        supabase,
        params.id,
        user.email || user.id,
      );
      throw redirect(`/admin/pipeline/jobs/${newJob.id}`);
    }
    return { error: "Unsupported action." };
  } catch (error: any) {
    if (error instanceof Response) throw error;
    return { error: error.message || "Job action failed." };
  }
}

type BadgeTone = "success" | "danger" | "warning" | "muted" | "brand";

const statusTones: Record<string, BadgeTone> = {
  succeeded: "success",
  completed: "success",
  failed: "danger",
  running: "warning",
  queued: "warning",
  cancelled: "muted",
  ingested: "brand",
  extracted: "brand",
  diarized: "brand",
};

function sentence(value: string) {
  const text = value.replaceAll("_", " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function StatusBadge({ status }: { status: string }) {
  return (
    <Badge variant={statusTones[status] ?? "muted"}>{sentence(status)}</Badge>
  );
}

const card = "rounded-2xl border border-zinc-200 bg-white shadow-sm";
const logPanel =
  "overflow-auto rounded-xl border border-zinc-200 bg-zinc-50 p-3 font-mono text-xs leading-relaxed text-zinc-800";

function JsonBlock({ value, className }: { value: unknown; className?: string }) {
  return (
    <pre className={cn(logPanel, "max-h-80", className)}>
      {JSON.stringify(value || {}, null, 2)}
    </pre>
  );
}

function SectionTitle({ title, meta }: { title: string; meta?: ReactNode }) {
  return (
    <div className="mb-3 flex items-baseline gap-3">
      <h2 className="text-lg font-semibold text-zinc-900">{title}</h2>
      {meta && <span className="text-sm tabular-nums text-zinc-500">{meta}</span>}
    </div>
  );
}

function EmptyNote({ children }: { children: ReactNode }) {
  return <p className="text-sm text-zinc-500">{children}</p>;
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
  return "Time unavailable";
}

function isStreamEvent(event: any) {
  return event.data?.stream === "info" || event.data?.stream === "warning";
}

/** Opens scrolled to the end: that's where a failure, or live progress, is. */
function TerminalLog({ events }: { events: any[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const lastId = events.at(-1)?.id;

  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lastId]);

  if (events.length === 0) {
    return <EmptyNote>No terminal output has been recorded for this job yet.</EmptyNote>;
  }

  return (
    <div
      ref={ref}
      role="log"
      aria-label="Terminal output"
      tabIndex={0}
      className={cn(logPanel, "max-h-[560px]")}
    >
      {events.map((event) => {
        const isStderr = event.level === "warning";
        return (
          <div
            key={event.id}
            className={cn(
              "grid grid-cols-[auto_minmax(0,1fr)] gap-x-3",
              isStderr && "text-amber-800",
            )}
          >
            <span className="select-none tabular-nums text-zinc-400">
              {formatLogTime(event.created_at)}
            </span>
            <span className="whitespace-pre-wrap break-words">
              {event.message}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function MetaRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[112px_minmax(0,1fr)] gap-3 px-4 py-2.5 text-sm">
      <dt className="text-zinc-500">{label}</dt>
      <dd className="min-w-0 text-zinc-900">{children}</dd>
    </div>
  );
}

function ArgumentValue({ name, value }: { name: string; value: unknown }) {
  if (name === "meeting_id" && value != null) {
    return (
      <Link
        to={`/meetings/${value}`}
        className="tabular-nums text-brand-700 hover:underline"
      >
        Meeting #{String(value)}
      </Link>
    );
  }
  if (Array.isArray(value)) return <>{value.join(", ")}</>;
  if (value && typeof value === "object") {
    return <span className="break-all font-mono text-xs">{JSON.stringify(value)}</span>;
  }
  return <span className="break-all tabular-nums">{String(value)}</span>;
}

export default function AdminPipelineJob({ loaderData }: Route.ComponentProps) {
  const { job, events, sourceMeeting } = loaderData;
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const revalidator = useRevalidator();
  const isSubmitting = navigation.state === "submitting";
  const canCancel = job.status === "queued";
  const canRetry = ["failed", "cancelled", "succeeded"].includes(job.status);
  const isActive = ["queued", "running"].includes(job.status);
  const isRunning = job.status === "running";
  const heartbeatAgeMs = job.locked_at
    ? Date.now() - new Date(job.locked_at).getTime()
    : null;
  const heartbeatAlive = heartbeatAgeMs != null && heartbeatAgeMs < 90_000;
  const streamEvents = events.filter(isStreamEvent);
  const lifecycleEvents = events.filter((event: any) => !isStreamEvent(event));
  const args = Object.entries((job.args as Record<string, unknown>) || {}).filter(
    ([name]) => !(name === "source_meeting_id" && sourceMeeting),
  );
  const hasResult = job.result && Object.keys(job.result).length > 0;
  const details = job.last_error ? errorDetails(job.last_error) : null;

  useEffect(() => {
    if (!isActive) return;
    const id = window.setInterval(() => revalidator.revalidate(), 5000);
    return () => window.clearInterval(id);
  }, [isActive, revalidator]);

  return (
    <div className="min-h-screen bg-zinc-50">
      <div className="container mx-auto max-w-6xl px-4 py-12">
        <DetailHeader
          back={{ to: "/admin/pipeline", label: "Pipeline" }}
          meta={[
            <span key="id" className="tabular-nums">
              Job #{job.id}
            </span>,
            <span key="when">
              {jobLifecycleSummary(job)}
              {job.requested_by ? ` by ${job.requested_by}` : ""}
            </span>,
          ]}
          title={sentence(job.job_type)}
          badges={<StatusBadge status={job.status} />}
          actions={
            (canCancel || canRetry) && (
              <>
                {canCancel && (
                  <Form method="post">
                    <Button
                      type="submit"
                      name="intent"
                      value="cancel"
                      variant="outline"
                      disabled={isSubmitting}
                    >
                      Cancel job
                    </Button>
                  </Form>
                )}
                {canRetry && (
                  <Form method="post">
                    <Button
                      type="submit"
                      name="intent"
                      value="retry"
                      variant={job.status === "failed" ? "default" : "outline"}
                      disabled={isSubmitting}
                    >
                      Requeue
                    </Button>
                  </Form>
                )}
              </>
            )
          }
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

        {job.last_error && (
          <div className="mb-8 rounded-2xl border border-red-200 bg-red-50 px-5 py-4">
            <p className="text-base font-medium text-red-900">
              {shortError(job.last_error)}
            </p>
            {details && <p className="mt-1 text-sm text-red-800">{details}</p>}
            <details className="group mt-2">
              <summary className="cursor-pointer text-xs font-medium text-red-700/80 hover:text-red-900">
                <span className="group-open:hidden">Show raw error</span>
                <span className="hidden group-open:inline">Hide raw error</span>
              </summary>
              <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-red-800">
                {job.last_error}
              </pre>
            </details>
          </div>
        )}

        <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_320px]">
          <div className="min-w-0 space-y-10">
            <section>
              <SectionTitle
                title="Terminal log"
                meta={
                  streamEvents.length > 0
                    ? `${streamEvents.length.toLocaleString()} lines`
                    : undefined
                }
              />
              <TerminalLog events={streamEvents} />
            </section>

            <section>
              <SectionTitle title="Job events" />
              {lifecycleEvents.length === 0 ? (
                <EmptyNote>
                  No lifecycle events have been recorded for this job yet.
                </EmptyNote>
              ) : (
                <ol className={cn(card, "divide-y divide-zinc-100")}>
                  {lifecycleEvents.map((event: any) => {
                    const hasData =
                      event.data && Object.keys(event.data).length > 0;
                    return (
                      <li key={event.id} className="px-4 py-2.5 text-sm">
                        <div className="flex items-baseline gap-3">
                          <span className="w-20 shrink-0 text-xs tabular-nums text-zinc-400">
                            {formatLogTime(event.created_at)}
                          </span>
                          <span
                            className={cn(
                              "min-w-0 flex-1",
                              event.level === "error"
                                ? "font-medium text-red-700"
                                : event.level === "warning"
                                  ? "text-amber-800"
                                  : "text-zinc-900",
                            )}
                          >
                            {event.message}
                          </span>
                        </div>
                        {hasData && (
                          <details className="group mt-1 pl-[92px]">
                            <summary className="cursor-pointer text-xs font-medium text-zinc-500 hover:text-brand-700">
                              <span className="group-open:hidden">Show data</span>
                              <span className="hidden group-open:inline">Hide data</span>
                            </summary>
                            <JsonBlock value={event.data} className="mt-2" />
                          </details>
                        )}
                      </li>
                    );
                  })}
                </ol>
              )}
            </section>

            {(hasResult || isActive) && (
              <section>
                <SectionTitle title="Result" />
                {hasResult ? (
                  <JsonBlock value={job.result} className="max-h-96" />
                ) : (
                  <EmptyNote>
                    No result yet. The worker writes one when the job finishes.
                  </EmptyNote>
                )}
              </section>
            )}
          </div>

          <aside className="min-w-0 space-y-8">
            <section>
              <SectionTitle title="Details" />
              <dl className={cn(card, "divide-y divide-zinc-100")}>
                {sourceMeeting && (
                  <MetaRow label="Meeting">
                    <div className="font-medium">{sourceMeeting.title}</div>
                    <div className="text-xs text-zinc-500">
                      {formatDate(sourceMeeting.meeting_date, {
                        month: "short",
                        day: "numeric",
                        year: "numeric",
                      })}
                      {sourceMeeting.ingested_meeting_id && (
                        <>
                          {" · "}
                          <Link
                            to={`/meetings/${sourceMeeting.ingested_meeting_id}`}
                            className="text-brand-700 hover:underline"
                          >
                            View meeting
                          </Link>
                        </>
                      )}
                    </div>
                  </MetaRow>
                )}
                {args.map(([name, value]) => (
                  <MetaRow key={name} label={sentence(name.replace(/_id$/, ""))}>
                    <ArgumentValue name={name} value={value} />
                  </MetaRow>
                ))}
                <MetaRow label="Started">
                  <span className="tabular-nums">
                    {job.started_at ? formatDateTime(job.started_at) : "Not started"}
                  </span>
                </MetaRow>
                {job.started_at && job.finished_at && (
                  <MetaRow label="Duration">
                    <span className="tabular-nums">
                      {formatDuration(job.started_at, job.finished_at)}
                    </span>
                  </MetaRow>
                )}
                <MetaRow label="Attempts">
                  <span className="tabular-nums">
                    {job.attempt_count} of {job.max_attempts}
                  </span>
                </MetaRow>
                {isRunning && (
                  <MetaRow label="Heartbeat">
                    <span
                      className={cn(
                        "tabular-nums",
                        heartbeatAlive ? "text-zinc-900" : "font-medium text-red-700",
                      )}
                    >
                      {job.locked_at
                        ? `${heartbeatAlive ? "Alive" : "Stale"} · ${formatRelativeTime(job.locked_at)}`
                        : "No heartbeat"}
                    </span>
                    {job.locked_by && (
                      <div className="break-all text-xs text-zinc-500">
                        {job.locked_by}
                      </div>
                    )}
                  </MetaRow>
                )}
              </dl>
            </section>

            {sourceMeeting?.archive_path && (
              <p className="break-all px-1 font-mono text-xs text-zinc-400">
                {sourceMeeting.archive_path}
              </p>
            )}
          </aside>
        </div>
      </div>
    </div>
  );
}
