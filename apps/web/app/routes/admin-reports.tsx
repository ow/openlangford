import { useState } from "react";
import { Form, Link, data, useNavigation } from "react-router";
import type { Route } from "./+types/admin-reports";
import { adminRead, privateAdminHeaders } from "../lib/admin-read.server";
import { requireModerator } from "../lib/auth.server";
import { getSupabaseAdminClient } from "../lib/supabase.server";
import { accountEmailFor } from "../lib/redact-email";
import { adminCard, adminLink } from "../components/admin/audience-layout";
import { PageHeader } from "../components/ui/page-header";
import { cn } from "../lib/utils";
import { reviewTime } from "../lib/page-review-types";
import { REPORT_CATEGORIES, REPORT_FILTERS, VERDICT_LABELS, type DataReport, type ReportFilter } from "../lib/data-reports";
import { approveReport, assessReport, declineReport, getReport, listReports, notifyReporter } from "../services/data-reports.server";

export const meta = () => [
  { title: "Reader reports | Admin | Open Langford" },
  { name: "robots", content: "noindex, nofollow" },
];
export const headers = privateAdminHeaders;

export async function loader({ request, params }: Route.LoaderArgs) {
  return adminRead(request, async (role) => {
    const supabase = getSupabaseAdminClient();
    const show = new URL(request.url).searchParams.get("show");
    const filter: ReportFilter = REPORT_FILTERS.some(([value]) => value === show) ? (show as ReportFilter) : "open";
    if (params.id) {
      const report = /^\d+$/.test(params.id) ? await getReport(supabase, Number(params.id)) : null;
      if (!report) throw data("Report not found", { status: 404, headers: privateAdminHeaders() });
      const reporter = report.user_id ? (await supabase.auth.admin.getUserById(report.user_id)).data.user?.email ?? null : null;
      const { open } = await listReports(supabase, "open");
      return { show: filter, reports: [report], open, single: true, reporter: accountEmailFor(role)(reporter) };
    }
    const { reports, open } = await listReports(supabase, filter);
    return { show: filter, reports, open, single: false, reporter: null };
  });
}

/** approve (fix, reply) | decline (reply) | assess. Every POST is recorded in staff_actions by requireModerator. */
export async function action({ request, context }: Route.ActionArgs) {
  const user = await requireModerator(request);
  const form = await request.formData();
  const intent = String(form.get("intent") || "");
  const id = Number(form.get("id"));
  const supabase = getSupabaseAdminClient();
  const bad = (error: string, status = 400) => data({ error, id }, { status, headers: privateAdminHeaders() });
  const report = Number.isInteger(id) ? await getReport(supabase, id) : null;
  if (!report) return bad("Report not found.", 404);
  try {
    if (intent === "assess") {
      await assessReport(supabase, new URL(request.url).origin, id);
      return data({ ok: true, id, message: "The agent has looked at it again." }, { headers: privateAdminHeaders() });
    }
    if (report.status !== "new" && report.status !== "assessed") return bad("This report has already been decided.");
    const reply = String(form.get("reply") || "").trim();
    if (intent === "approve") {
      const fix = String(form.get("fix") || "").trim();
      if (!fix) return bad("Say what should change on the page.");
      await approveReport(supabase, report, fix, reply, user.id);
    } else if (intent === "decline") {
      await declineReport(supabase, report, reply, user.id);
    } else return bad("Unknown action.");
    const { cloudflare } = context as { cloudflare?: { env?: { RESEND_API_KEY?: string } } };
    const decided = await getReport(supabase, id);
    const emailed = decided ? await notifyReporter({ apiKey: cloudflare?.env?.RESEND_API_KEY, supabase, report: decided }) : "skipped";
    const message = intent === "approve"
      ? "Sent to the page as an issue. Open the page and press Fix in the review bar to have the agent make the change."
      : "Declined.";
    return data({ ok: true, id, message: `${message}${emailed === "sent" ? " The reader has been emailed." : ""}` }, { headers: privateAdminHeaders() });
  } catch (error) {
    return bad(error instanceof Error ? error.message : "That didn't work.", 503);
  }
}

const STATUS_LABELS: Record<DataReport["status"], string> = {
  new: "Waiting for the agent", assessed: "To decide", resolved: "Fixed", declined: "Declined", duplicate: "Duplicate",
};
const categoryLabel = (value: string) => REPORT_CATEGORIES.find((c) => c.value === value)?.label ?? value;

export default function AdminReports({ loaderData, actionData }: Route.ComponentProps) {
  const { show, reports, open, single, reporter } = loaderData;
  return (
    <main className="min-h-screen bg-zinc-50">
      <div className="container mx-auto max-w-4xl px-4 py-10">
        <Link to={single ? "/admin/reports" : "/admin"} className={`${adminLink} mb-5 inline-block text-sm`}>
          ← {single ? "All reports" : "Admin area"}
        </Link>
        <PageHeader
          title="Reader reports"
          description="Problems readers reported on public pages. The agent checks each one against the records and suggests what to do; nothing changes until you approve it."
        />
        {!single && (
          <nav aria-label="Filter reports" className="mb-4 flex flex-wrap gap-2 text-sm">
            {REPORT_FILTERS.map(([value, label]) => (
              <Link key={value} to={value === "open" ? "/admin/reports" : `/admin/reports?show=${value}`}
                className={cn("rounded-full border px-3 py-1", show === value ? "border-brand-300 bg-brand-50 text-brand-800" : "border-zinc-200 text-zinc-600 hover:bg-zinc-100")}>
                {label}{value === "open" && open > 0 ? ` (${open})` : ""}
              </Link>
            ))}
          </nav>
        )}
        {reports.length === 0 ? (
          <p className="text-sm text-zinc-500">{show === "open" ? "No reports waiting. 🎉" : "Nothing here yet."}</p>
        ) : (
          <ul className="grid gap-3">
            {reports.map((r) => (
              <ReportCard key={`${r.id}-${r.assessed_at}`} report={r} reporter={single ? reporter : null}
                result={actionData && "id" in actionData && actionData.id === r.id ? actionData : null} />
            ))}
          </ul>
        )}
      </div>
    </main>
  );
}

function ReportCard({ report: r, reporter, result }: {
  report: DataReport; reporter: string | null; result: { error?: string; message?: string } | null;
}) {
  const navigation = useNavigation();
  const busy = navigation.state !== "idle" && navigation.formData?.get("id") === String(r.id);
  const a = r.assessment;
  const [fix, setFix] = useState(a?.proposed_fix ?? r.suggestion ?? "");
  const [reply, setReply] = useState(a?.reply ?? "");
  const decided = r.status !== "new" && r.status !== "assessed";
  return (
    <li className={cn(adminCard, "px-5 py-4")} id={`report-${r.id}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <Link to={r.path} className="font-medium text-zinc-900 hover:text-brand-700">{r.path}</Link>
        <span className="text-xs text-zinc-500">
          <Link to={`/admin/reports/${r.id}`} className="hover:underline">#{r.id}</Link> · {reviewTime(r.created_at)} · {STATUS_LABELS[r.status]}
        </span>
      </div>
      <p className="mt-1 text-xs font-medium text-amber-800">{categoryLabel(r.category)}{r.entry_key ? ` · entry ${r.entry_key}` : ""}</p>
      {r.quote && <blockquote className="mt-2 border-l-2 border-zinc-300 pl-3 text-sm text-zinc-700">{r.quote}</blockquote>}
      {r.note && <p className="mt-2 whitespace-pre-line text-sm text-zinc-800">{r.note}</p>}
      {r.suggestion && <p className="mt-1 text-sm text-zinc-600"><span className="font-medium">Should say:</span> {r.suggestion}</p>}
      {r.source_url && (
        <p className="mt-1 truncate text-sm">
          <span className="font-medium text-zinc-600">Source:</span>{" "}
          <a href={r.source_url} target="_blank" rel="noopener noreferrer nofollow" className={adminLink}>{r.source_url}</a>
        </p>
      )}
      {reporter && <p className="mt-1 text-xs text-zinc-500">From {reporter}{r.notify_reporter ? "" : " (doesn't want an email back)"}</p>}

      {a ? (
        <div className="mt-3 rounded-lg bg-zinc-50 px-3 py-2.5 text-sm">
          <p className="font-medium text-zinc-900">Agent: {VERDICT_LABELS[a.verdict]}</p>
          <p className="mt-1 text-zinc-700">{a.findings}</p>
        </div>
      ) : (
        <p className="mt-3 text-sm text-zinc-500">The agent hasn't looked at this yet (it runs every few minutes).</p>
      )}

      {decided ? (
        r.resolution && <p className="mt-3 text-sm text-zinc-600"><span className="font-medium">Told the reader:</span> {r.resolution}</p>
      ) : (
        <Form method="post" className="mt-3 grid gap-2">
          <input type="hidden" name="id" value={r.id} />
          <label className="grid gap-1 text-sm">
            <span className="font-medium text-zinc-700">Fix for the page agent</span>
            <textarea name="fix" rows={2} value={fix} onChange={(e) => setFix(e.target.value)}
              className="rounded-lg border border-zinc-300 bg-white px-3 py-2" placeholder="What should change on the page" />
          </label>
          <label className="grid gap-1 text-sm">
            <span className="font-medium text-zinc-700">Note to the reader {r.notify_reporter ? "" : <span className="font-normal text-zinc-500">(not emailed: they opted out)</span>}</span>
            <textarea name="reply" rows={2} value={reply} onChange={(e) => setReply(e.target.value)}
              className="rounded-lg border border-zinc-300 bg-white px-3 py-2" />
          </label>
          <div className="flex flex-wrap gap-2">
            <button name="intent" value="approve" disabled={busy || !fix.trim()}
              className="rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50">Approve fix</button>
            <button name="intent" value="decline" disabled={busy}
              className="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-100 disabled:opacity-50">Decline</button>
            <button name="intent" value="assess" disabled={busy}
              className="rounded-lg px-3 py-1.5 text-sm text-zinc-600 hover:bg-zinc-100 disabled:opacity-50">{a ? "Ask the agent again" : "Ask the agent now"}</button>
          </div>
        </Form>
      )}
      {busy && <p className="mt-2 text-sm text-zinc-500">Working…</p>}
      {result?.error && <p className="mt-2 text-sm text-red-700">{result.error}</p>}
      {result?.message && <p className="mt-2 text-sm text-emerald-700">{result.message}</p>}
    </li>
  );
}
