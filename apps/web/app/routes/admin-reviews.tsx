import { Form, Link, useActionData, useNavigation } from "react-router";
import { Loader2 } from "lucide-react";
import type { Route } from "./+types/admin-reviews";
import { adminRead, privateAdminHeaders } from "../lib/admin-read.server";
import { getSupabaseAdminClient } from "../lib/supabase.server";
import { adminCard, adminLink } from "../components/admin/audience-layout";
import { PageHeader } from "../components/ui/page-header";
import { cn } from "../lib/utils";
import { PRECHECK_MAX, reviewTime, unresolvedFlags } from "../lib/page-review-types";
import { listPageReviews, reviewCoverage, type ReviewFilter } from "../services/page-reviews.server";
import { decideGuidance, draftGuidance, learningOverview } from "../services/review-learning.server";
import { precheckState, queuePrecheck } from "../services/page-precheck.server";
import { SITEMAP_SECTIONS, type SitemapSection } from "../services/sitemap.server";
import { ReviewLearningSection } from "../components/admin/review-learning-section";
import { FLAG_PROBLEM_LABELS, type FlagProblem } from "../lib/page-review-types";
import { requireModerator } from "../lib/auth.server";
import { data } from "react-router";

export const meta = () => [
  { title: "Page reviews | Admin | Open Langford" },
  { name: "robots", content: "noindex, nofollow" },
];
export const headers = privateAdminHeaders;

const FILTERS = [["attention", "Needs you"], ["fixed", "Fixed, to confirm"], ["needs_work", "Needs work"], ["flagged", "Open flags"], ["reviewed", "Reviewed"]] as const;

export async function loader({ request }: Route.LoaderArgs) {
  return adminRead(request, async () => {
    const show = new URL(request.url).searchParams.get("show");
    const filter: ReviewFilter = show === "needs_work" || show === "reviewed" || show === "flagged" || show === "fixed" ? show : "attention";
    const supabase = getSupabaseAdminClient();
    const { rows, ...list } = await listPageReviews(supabase, filter);
    const [coverage, learning, precheck] = await Promise.all([reviewCoverage(supabase, rows), learningOverview(supabase), precheckState(supabase)]);
    return { show: filter, ...list, coverage, learning, precheck };
  });
}

/** Queue pages for a check ahead of review; draft, approve or discard a guidance rule for the page check. */
export async function action({ request }: Route.ActionArgs) {
  const user = await requireModerator(request);
  const form = await request.formData();
  const intent = String(form.get("intent") || "");
  const supabase = getSupabaseAdminClient();
  try {
    if (intent === "precheck") {
      const kind = String(form.get("kind") || "matters");
      const section = kind === "any" || (SITEMAP_SECTIONS as readonly string[]).includes(kind) ? kind as SitemapSection | "any" : "matters";
      const queued = await queuePrecheck(supabase, section, Number(form.get("count")) || 10);
      return data({ ok: true, queued }, { headers: privateAdminHeaders() });
    } else if (intent === "draft_rule") {
      const problem = String(form.get("problem") || "") as FlagProblem;
      if (!(problem in FLAG_PROBLEM_LABELS)) return data({ error: "Unknown problem type." }, { status: 400, headers: privateAdminHeaders() });
      await draftGuidance(supabase, problem, FLAG_PROBLEM_LABELS[problem]);
    } else if (intent === "approve_rule" || intent === "reject_rule") {
      await decideGuidance(supabase, Number(form.get("id")), intent === "approve_rule" ? "approve" : "reject",
        String(form.get("text") || "") || null, user.id);
    } else return data({ error: "Unknown action." }, { status: 400, headers: privateAdminHeaders() });
    return data({ ok: true }, { headers: privateAdminHeaders() });
  } catch (error) {
    return data({ error: error instanceof Error ? error.message : "That didn't work." }, { status: 503, headers: privateAdminHeaders() });
  }
}

export default function AdminReviews({ loaderData }: Route.ComponentProps) {
  const { show, reviews, coverage, learning, precheck } = loaderData;
  const answer = useActionData<typeof action>();
  const navigation = useNavigation();
  const queueing = navigation.formData?.get("intent") === "precheck";
  const n = (value: number) => value.toLocaleString();
  return (
    <main className="min-h-screen bg-zinc-50">
      <div className="container mx-auto max-w-4xl px-4 py-10">
        <Link to="/admin" className={`${adminLink} mb-5 inline-block text-sm`}>← Admin area</Link>
        <PageHeader
          title="Page reviews"
          description="Pages you've looked over or had checked. While signed in, every public page has a review bar at the bottom left: mark it reviewed, or press Check to have the model read it and flag problems."
        />
        <div className={cn(adminCard, "mb-3 px-5 py-4")}>
          <div className="text-sm font-medium text-zinc-600">Pages reviewed</div>
          <div className="mt-1 text-3xl font-semibold tabular-nums text-zinc-950">
            {n(coverage.reviewed)} <span className="text-lg font-normal text-zinc-500">of {n(coverage.total)}</span>
          </div>
          <p className="mt-1 text-xs text-zinc-500">{n(coverage.checked)} checked by the model. Every public page in the sitemap counts.</p>
          <ul className="mt-4 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
            {coverage.sections.map((s) => (
              <li key={s.section} className="flex items-baseline justify-between gap-3 border-t border-zinc-100 pt-2">
                <Link to={`/admin/reviews/next?kind=${s.section}`} title={`Review a random ${s.label.toLowerCase()} page`}
                  className="font-medium text-brand-700 hover:underline">{s.label}</Link>
                <span className="tabular-nums text-zinc-600">
                  {n(s.reviewed)} of {n(s.total)}{s.checked > 0 && <span className="text-zinc-400"> · {n(s.checked)} checked</span>}
                </span>
              </li>
            ))}
          </ul>
        </div>
        <div className="mb-5 grid gap-3 sm:grid-cols-2">
          {/* Pre-check: queue a batch so each page's check is done before you get to it. */}
          <div className={cn(adminCard, "px-5 py-4")}>
            <div className="text-sm font-medium text-zinc-600">Pre-check a batch</div>
            <p className="mt-1 text-xs text-zinc-500">
              Picks pages nobody has reviewed or checked and checks them in the background, a few every five minutes,
              so you can go through them without waiting on each check.
            </p>
            <Form method="post" className="mt-3 flex flex-wrap items-center gap-2 text-sm">
              <input type="hidden" name="intent" value="precheck" />
              <input type="number" name="count" min={1} max={PRECHECK_MAX} defaultValue={20} aria-label="How many pages"
                className="w-16 rounded-lg border border-zinc-300 bg-surface px-2 py-1 tabular-nums" />
              <select name="kind" defaultValue="matters" aria-label="Which pages" className="rounded-lg border border-zinc-300 bg-surface px-2 py-1">
                {coverage.sections.map((sec) => <option key={sec.section} value={sec.section}>{sec.label}</option>)}
                <option value="any">Any kind</option>
              </select>
              <button type="submit" disabled={queueing}
                className="rounded-lg border border-brand-300 px-3 py-1 font-medium text-brand-800 hover:bg-brand-50">
                {queueing ? <><Loader2 className="mr-1 inline h-3.5 w-3.5 animate-spin align-[-2px]" />Queueing…</> : "Queue"}
              </button>
            </Form>
            {answer && "queued" in answer && (
              <p className="mt-2 text-xs text-zinc-600">{answer.queued ? `Queued ${answer.queued}. The first ones are checked within five minutes.` : "No unchecked pages of that kind left."}</p>
            )}
            {(precheck.queued > 0 || precheck.ready > 0) && (
              <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-zinc-100 pt-3 text-sm">
                <span className="tabular-nums text-zinc-600">
                  {precheck.ready > 0 && <>{n(precheck.ready)} checked and ready</>}
                  {precheck.ready > 0 && precheck.queued > 0 && " · "}
                  {precheck.queued > 0 && <>{n(precheck.queued)} still to check</>}
                </span>
                {precheck.ready > 0 && (
                  <Link to="/admin/reviews/next?kind=checked" className="rounded-lg bg-brand-600 px-3 py-1.5 font-medium text-white hover:bg-brand-700">Review checked pages</Link>
                )}
              </div>
            )}
          </div>
          <div className={cn(adminCard, "flex flex-col justify-between px-5 py-4")}>
            <div>
              <div className="text-sm font-medium text-zinc-600">Sample a page</div>
              <p className="mt-1 text-xs text-zinc-500">Any page nobody has reviewed or checked. To stay in one kind, pick it from the list above. After each page you go on to the next in the same mode.</p>
            </div>
            <Link to="/admin/reviews/next?kind=any"
              className="mt-3 self-start rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700">Random page</Link>
          </div>
        </div>
        <ReviewLearningSection rows={learning} />
        <nav aria-label="Filter reviews" className="mb-4 flex flex-wrap gap-2 text-sm">
          {FILTERS.map(([value, label]) => (
            <Link key={value} to={value === "attention" ? "/admin/reviews" : `/admin/reviews?show=${value}`}
              className={cn("rounded-full border px-3 py-1", show === value ? "border-brand-300 bg-brand-50 text-brand-800" : "border-zinc-200 text-zinc-600 hover:bg-zinc-100")}>
              {label}
            </Link>
          ))}
        </nav>
        {reviews.length === 0 ? (
          <p className="text-sm text-zinc-500">{show === "attention" ? "Nothing is waiting on you." : "Nothing here yet."}</p>
        ) : (
          <ul className={cn(adminCard, "divide-y divide-zinc-100 overflow-hidden")}>
            {reviews.map((r) => {
              const flags = r.ai_flags || [];
              const open = unresolvedFlags(flags).length;
              const unrated = flags.filter(f => !f.verdict).length;
              return (
                <li key={r.path} className="px-5 py-3">
                  <Link to={r.path} className="block font-medium text-zinc-900 hover:text-brand-700">{r.title || r.path}</Link>
                  <p className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-xs font-medium">
                    {r.status && (
                      <span className={r.status === "reviewed" ? "text-emerald-700" : r.status === "fixed" ? "text-brand-700" : "text-amber-700"}>
                        {{ reviewed: "Reviewed", needs_work: "Needs work", fixing: "Agent fixing", fixed: "Fixed, to confirm" }[r.status]}{r.reviewed_at ? ` · ${reviewTime(r.reviewed_at)}` : ""}
                      </span>
                    )}
                    {r.ai_checked_at && (
                      flags.length === 0 ? <span className="text-zinc-500">Checked, no flags</span>
                        : open === 0 ? <span className="text-emerald-700">{flags.length} {flags.length === 1 ? "flag" : "flags"}, all resolved</span>
                        : <span className="text-amber-700">{open} of {flags.length} {flags.length === 1 ? "flag" : "flags"} open{unrated ? ` · ${unrated} unrated` : ""}</span>
                    )}
                  </p>
                  <p className="truncate text-xs text-zinc-500">{r.path}</p>
                  {r.ai_page_issue && open > 0 && <p className="mt-1 text-sm text-amber-800">Whole page: {r.ai_page_issue}</p>}
                  {r.ai_summary && (
                    <p className="mt-1 text-sm text-zinc-600">
                      <span className="text-xs font-medium text-zinc-500">The check, {reviewTime(r.ai_checked_at)}: </span>{r.ai_summary}
                    </p>
                  )}
                  {r.note && <p className="mt-1 whitespace-pre-line text-sm text-zinc-700">{r.note}</p>}
                  {r.agent_note && <p className="mt-1 whitespace-pre-line rounded-lg bg-zinc-50 px-2.5 py-2 text-xs text-zinc-600">{r.agent_note}</p>}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </main>
  );
}
