import { SITE_NAME } from "../lib/site-name";
import { meetingPath } from "../lib/paths";
import { DEFAULT_MUNICIPALITY } from "../lib/site-config";
import { personPath } from "../lib/people-paths";
import { resolvePersonParam } from "../lib/people.server";
import type { Route } from "./+types/person-proposals";
import { getPersonProposals } from "../services/people";
import { Link, useSearchParams } from "react-router";
import { ChevronLeft, ChevronRight, Gavel } from "lucide-react";
import { MotionOutcomeBadge as OutcomeBadge } from "../components/motion-outcome-badge";
import { Button } from "../components/ui/button";
import { DetailHeader } from "../components/ui/detail-header";
import { cn, formatDate } from "../lib/utils";
import { displayTitle } from "../lib/display-text";
import { getSupabaseAdminClient } from "../lib/supabase.server";
import { ogImageUrl, ogUrl } from "../lib/og";

export const meta: Route.MetaFunction = ({ data }) => {
  const person = (data as any)?.person;
  if (!person) return [{ title: `Legislative Proposals | ${SITE_NAME}` }];
  const title = `${person.name} — Legislative Proposals | ${SITE_NAME}`;
  const description = `Motions moved and seconded by ${person.name} on ${DEFAULT_MUNICIPALITY.short_name} council`;
  return [
    { title },
    { name: "description", content: description },
    { property: "og:title", content: `${person.name} — Legislative Proposals` },
    { property: "og:description", content: description },
    { property: "og:type", content: "profile" },
    { property: "og:url", content: ogUrl(personPath(person, "/proposals")) },
    { property: "og:image", content: ogImageUrl(`${person.name} — Legislative Proposals`, { type: "person" }) },
    { property: "og:image:width", content: "1200" },
    { property: "og:image:height", content: "630" },
    { name: "twitter:card", content: "summary_large_image" },
  ];
};

export async function loader({ params, request }: Route.LoaderArgs) {
  const { id } = params;
  const url = new URL(request.url);
  const page = parseInt(url.searchParams.get("page") || "0", 10);
  const roleFilter = url.searchParams.get("role") || "All";
  const pageSize = 50;

  try {
    const supabase = getSupabaseAdminClient();
    // 1. Fetch person basic info
    const person = await resolvePersonParam(supabase, id, request, "/proposals");

    // 2. Fetch motions based on role
    let motions: any[] = [];
    let totalCount = 0;

    if (roleFilter === "All" || roleFilter === "Mover") {
      const { data, count } = await supabase
        .from("motions")
        .select(
          "id, text_content, plain_english_summary, result, meeting_id, meetings(slug, id, title, meeting_date)",
          { count: "exact" },
        )
        .eq("mover_id", person.id)
        .order("meeting_id", { ascending: false });

      if (data) motions.push(...data.map((m) => ({ ...m, role: "Mover" })));
      if (roleFilter === "Mover") totalCount = count || 0;
    }

    if (roleFilter === "All" || roleFilter === "Seconder") {
      const { data, count } = await supabase
        .from("motions")
        .select(
          "id, text_content, plain_english_summary, result, meeting_id, meetings(slug, id, title, meeting_date)",
          { count: "exact" },
        )
        .eq("seconder_id", person.id)
        .order("meeting_id", { ascending: false });

      if (data) motions.push(...data.map((m) => ({ ...m, role: "Seconder" })));
      if (roleFilter === "Seconder") totalCount = count || 0;
    }

    // Manual merge and paginate if "All" is selected
    if (roleFilter === "All") {
      motions.sort((a, b) =>
        b.meetings.meeting_date.localeCompare(a.meetings.meeting_date),
      );
      totalCount = motions.length;
      motions = motions.slice(page * pageSize, (page + 1) * pageSize);
    } else {
      // If specific role, it's already sorted by ID/Meeting, but let's re-sort by date to be sure
      motions.sort((a, b) =>
        b.meetings.meeting_date.localeCompare(a.meetings.meeting_date),
      );
      motions = motions.slice(page * pageSize, (page + 1) * pageSize);
    }

    return {
      person,
      motions,
      total: totalCount,
      page,
      pageSize,
      currentRole: roleFilter,
    };
  } catch (error: any) {
    if (error instanceof Response) throw error;
    console.error("Error loading proposals:", error);
    throw new Response("Error loading legislative proposals", { status: 500 });
  }
}

export default function PersonProposals({ loaderData }: Route.ComponentProps) {
  const { person, motions, total, page, pageSize, currentRole } = loaderData;
  const [searchParams, setSearchParams] = useSearchParams();

  const totalPages = Math.ceil(total / pageSize);

  const handleRoleChange = (role: string) => {
    setSearchParams({ role, page: "0" });
  };

  const handlePageChange = (newPage: number) => {
    setSearchParams({ role: currentRole, page: newPage.toString() });
  };

  const roles = ["All", "Mover", "Seconder"] as const;

  return (
    <div className="min-h-screen bg-zinc-50">
      <div className="container mx-auto max-w-4xl px-4 py-12">
        <DetailHeader
          className="mb-6"
          back={{ to: personPath(person), label: person.name }}
          meta={[
            <span className="tabular-nums">
              {total.toLocaleString()} {total === 1 ? "motion" : "motions"} moved or seconded
            </span>,
          ]}
          title="Proposals"
          description={`Motions ${person.name} put forward or seconded at council meetings.`}
        />

        <div className="mb-4">
          <div
            role="tablist"
            aria-label="Filter by role"
            className="inline-flex max-w-full overflow-x-auto rounded-lg border border-zinc-200 bg-surface p-0.5 shadow-xs"
          >
            {roles.map((f) => (
              <button
                key={f}
                type="button"
                role="tab"
                aria-selected={currentRole === f}
                onClick={() => handleRoleChange(f)}
                className={cn(
                  "shrink-0 cursor-pointer rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                  currentRole === f
                    ? "bg-brand-50 text-brand-800"
                    : "text-zinc-600 hover:bg-zinc-50 hover:text-zinc-900",
                )}
              >
                {f === "Mover" ? "Moved" : f === "Seconder" ? "Seconded" : f}
              </button>
            ))}
          </div>
        </div>

        {motions.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-zinc-200 bg-surface px-6 py-14 text-center">
            <Gavel className="mx-auto mb-3 h-8 w-8 text-zinc-300" />
            <p className="text-sm text-zinc-500">
              No motions found for this role.
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-zinc-100 rounded-2xl border border-zinc-200 bg-surface shadow-sm">
            {motions.map((m: any, idx) => (
              <li
                key={`${m.id}-${m.role}-${idx}`}
                className="flex flex-col gap-2 px-4 py-4 sm:flex-row sm:gap-4 sm:px-5"
              >
                <div className="shrink-0 pt-0.5 sm:w-[5.5rem]">
                  <span
                    className={cn(
                      "inline-flex rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ring-inset",
                      m.role === "Mover"
                        ? "bg-brand-50 text-brand-700 ring-brand-100"
                        : "bg-zinc-100 text-zinc-600 ring-zinc-200",
                    )}
                  >
                    {m.role === "Mover" ? "Moved" : "Seconded"}
                  </span>
                </div>
                <div className="min-w-0 flex-1">
                  <p className="line-clamp-3 text-sm leading-relaxed text-zinc-800">
                    {m.plain_english_summary || m.text_content || "Motion text unavailable"}
                  </p>
                  <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
                    <Link
                      to={meetingPath({ id: m.meeting_id, slug: (Array.isArray(m.meetings) ? m.meetings[0] : m.meetings)?.slug })}
                      className="text-xs text-zinc-500 hover:text-brand-700"
                    >
                      <span className="tabular-nums">
                        {formatDate(m.meetings?.meeting_date, {
                          year: "numeric",
                          month: "short",
                          day: "numeric",
                        })}
                      </span>
                      {m.meetings?.title && (
                        <>
                          <span className="mx-1.5 text-zinc-300">·</span>
                          {displayTitle(m.meetings.title)}
                        </>
                      )}
                    </Link>
                    <OutcomeBadge result={m.result} className="sm:hidden" />
                  </div>
                </div>
                <div className="hidden shrink-0 pt-0.5 sm:block">
                  <OutcomeBadge result={m.result} />
                </div>
              </li>
            ))}
          </ul>
        )}

        {totalPages > 1 && (
          <div className="mt-8 flex items-center justify-center gap-3">
            <Button
              variant="outline"
              size="sm"
              disabled={page === 0}
              onClick={() => handlePageChange(page - 1)}
            >
              <ChevronLeft className="h-4 w-4" /> Previous
            </Button>
            <span className="text-sm text-zinc-500 tabular-nums">
              Page {page + 1} of {totalPages}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={page >= totalPages - 1}
              onClick={() => handlePageChange(page + 1)}
            >
              Next <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
