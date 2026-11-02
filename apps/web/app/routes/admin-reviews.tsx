import { Link } from "react-router";
import type { Route } from "./+types/admin-reviews";
import { adminRead, adminReadOnlyAction, privateAdminHeaders } from "../lib/admin-read.server";
import { getSupabaseAdminClient } from "../lib/supabase.server";
import { adminCard, adminLink } from "../components/admin/audience-layout";
import { PageHeader } from "../components/ui/page-header";
import { cn } from "../lib/utils";
import { reviewTime, unresolvedFlags } from "../lib/page-review-types";
import { listPageReviews, reviewCoverage, type ReviewFilter } from "../services/page-reviews.server";

export const meta = () => [
  { title: "Page reviews | Admin | Open Langford" },
  { name: "robots", content: "noindex, nofollow" },
];
export const headers = privateAdminHeaders;

const FILTERS = [["all", "All"], ["fixed", "Fixed, to confirm"], ["needs_work", "Needs work"], ["flagged", "Open flags"], ["reviewed", "Reviewed"]] as const;

export async function loader({ request }: Route.LoaderArgs) {
  return adminRead(request, async () => {
    const show = new URL(request.url).searchParams.get("show");
    const filter: ReviewFilter = show === "needs_work" || show === "reviewed" || show === "flagged" || show === "fixed" ? show : null;
    const supabase = getSupabaseAdminClient();
    const { rows, ...list } = await listPageReviews(supabase, filter);
    return { show: filter ?? "all", ...list, coverage: await reviewCoverage(supabase, rows) };
  });
}

export const action = adminReadOnlyAction;

export default function AdminReviews({ loaderData }: Route.ComponentProps) {
  const { show, reviews, agreement, coverage } = loaderData;
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
          <div className={cn(adminCard, "px-5 py-4")}>
            <div className="text-sm font-medium text-zinc-600">Check flags you agreed with</div>
            <div className="mt-1 text-3xl font-semibold tabular-nums text-zinc-950">
              {agreement.rated ? `${Math.round((agreement.agreed / agreement.rated) * 100)}%` : "—"}
            </div>
            <p className="mt-1 text-xs text-zinc-500">{agreement.agreed} of {agreement.rated} rated flags were real problems. Your ratings guide later checks.</p>
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
        <nav aria-label="Filter reviews" className="mb-4 flex flex-wrap gap-2 text-sm">
          {FILTERS.map(([value, label]) => (
            <Link key={value} to={value === "all" ? "/admin/reviews" : `/admin/reviews?show=${value}`}
              className={cn("rounded-full border px-3 py-1", show === value ? "border-brand-300 bg-brand-50 text-brand-800" : "border-zinc-200 text-zinc-600 hover:bg-zinc-100")}>
              {label}
            </Link>
          ))}
        </nav>
        {reviews.length === 0 ? (
          <p className="text-sm text-zinc-500">Nothing here yet.</p>
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
