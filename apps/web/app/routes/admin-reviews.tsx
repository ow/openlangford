import { Link } from "react-router";
import type { Route } from "./+types/admin-reviews";
import { adminRead, privateAdminHeaders } from "../lib/admin-read.server";
import { getSupabaseAdminClient } from "../lib/supabase.server";
import { adminCard, adminLink } from "../components/admin/audience-layout";
import { PageHeader } from "../components/ui/page-header";
import { cn, formatDate } from "../lib/utils";
import { listPageReviews, type PageReviewStatus } from "../services/page-reviews.server";

export const meta = () => [
  { title: "Page reviews | Admin | Open Langford" },
  { name: "robots", content: "noindex, nofollow" },
];
export const headers = privateAdminHeaders;

const FILTERS = [["all", "All"], ["needs_work", "Needs work"], ["reviewed", "Reviewed"]] as const;

export async function loader({ request }: Route.LoaderArgs) {
  return adminRead(request, async () => {
    const show = new URL(request.url).searchParams.get("show");
    const status: PageReviewStatus | null = show === "needs_work" || show === "reviewed" ? show : null;
    return { show: status ?? "all", ...(await listPageReviews(getSupabaseAdminClient(), status)) };
  });
}

export default function AdminReviews({ loaderData }: Route.ComponentProps) {
  const { show, reviews, byKind } = loaderData;
  const kinds = Object.entries(byKind).sort((a, b) => (b[1].reviewed + b[1].needs_work) - (a[1].reviewed + a[1].needs_work));
  return (
    <main className="min-h-screen bg-zinc-50">
      <div className="container mx-auto max-w-4xl px-4 py-10">
        <Link to="/admin" className={`${adminLink} mb-5 inline-block text-sm`}>← Admin area</Link>
        <PageHeader
          title="Page reviews"
          description="Pages you've looked over. Mark a page from the bar at the bottom left of any public page while signed in."
        />
        {kinds.length > 0 && (
          <div className={cn(adminCard, "mb-5 flex flex-wrap gap-x-6 gap-y-2 px-5 py-3 text-sm")}>
            {kinds.map(([kind, n]) => (
              <span key={kind} className="tabular-nums text-zinc-600">
                <span className="font-medium capitalize text-zinc-900">{kind}</span> {n.reviewed} reviewed
                {n.needs_work > 0 && <span className="text-amber-700"> · {n.needs_work} need work</span>}
              </span>
            ))}
          </div>
        )}
        <nav aria-label="Filter reviews" className="mb-4 flex gap-2 text-sm">
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
            {reviews.map((r) => (
              <li key={r.path} className="px-5 py-3">
                <div className="flex items-baseline justify-between gap-4">
                  <Link to={r.path} className="min-w-0 truncate font-medium text-zinc-900 hover:text-brand-700">{r.title || r.path}</Link>
                  <span className={cn("shrink-0 text-xs font-medium", r.status === "reviewed" ? "text-emerald-700" : "text-amber-700")}>
                    {r.status === "reviewed" ? "Reviewed" : "Needs work"} · {formatDate(r.reviewed_at)}
                  </span>
                </div>
                <p className="truncate text-xs text-zinc-500">{r.path}</p>
                {r.note && <p className="mt-1 whitespace-pre-line text-sm text-zinc-700">{r.note}</p>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </main>
  );
}
