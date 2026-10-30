import { SITE_NAME } from "../lib/site-name";
import { meetingPath } from "../lib/paths";
import { DEFAULT_MUNICIPALITY } from "../lib/site-config";
import { personPath } from "../lib/people-paths";
import { resolvePersonParam } from "../lib/people.server";
import type { Route } from "./+types/person-votes";
import { Link, useSearchParams } from "react-router";
import {
  ChevronLeft,
  ChevronRight,
  Info,
  Vote as VoteIcon,
} from "lucide-react";
import { MotionOutcomeBadge as OutcomeBadge } from "../components/motion-outcome-badge";
import { Button } from "../components/ui/button";
import { DetailHeader } from "../components/ui/detail-header";
import { cn, formatDate } from "../lib/utils";
import { displayTitle } from "../lib/display-text";
import { getSupabaseAdminClient } from "../lib/supabase.server";
import { ogImageUrl, ogPortrait, ogUrl } from "../lib/og";

export const meta: Route.MetaFunction = ({ data }) => {
  const person = (data as any)?.person;
  if (!person) return [{ title: `Voting Record | ${SITE_NAME}` }];
  const title = `${person.name} — Voting Record | ${SITE_NAME}`;
  const description = `Complete voting record for ${person.name} on ${DEFAULT_MUNICIPALITY.short_name} council`;
  return [
    { title },
    { name: "description", content: description },
    { property: "og:title", content: `${person.name} — Voting Record` },
    { property: "og:description", content: description },
    { property: "og:type", content: "profile" },
    { property: "og:url", content: ogUrl(personPath(person, "/votes")) },
    { property: "og:image", content: ogImageUrl(person.name, { subtitle: "Voting record: every recorded vote on council", type: "person", image: ogPortrait(person.image_url) }) },
    { property: "og:image:width", content: "1200" },
    { property: "og:image:height", content: "630" },
    { name: "twitter:card", content: "summary_large_image" },
  ];
};

export async function loader({ params, request }: Route.LoaderArgs) {
  const { id } = params;
  const url = new URL(request.url);
  const page = parseInt(url.searchParams.get("page") || "0", 10);
  const voteFilter = url.searchParams.get("filter") || "All";
  const pageSize = 50;

  try {
    const supabase = getSupabaseAdminClient();
    // 1. Fetch person basic info
    const person = await resolvePersonParam(supabase, id, request, "/votes");

    // 2. Fetch votes with simple filter applied at DB level if possible,
    // but our service currently filters in JS for complex logic.
    // Let's refine the service to handle basic filters.

    // Sort by meeting date (newest first). PostgREST can't order parent rows
    // by a column two relations away, and a person has at most a few hundred
    // vote rows, so fetch them all and sort/paginate here.
    let query = supabase
      .from("votes")
      .select(
        "id, motion_id, person_id, vote, recusal_reason, created_at, motions(id, text_content, plain_english_summary, result, meeting_id, meta, meetings(slug, id, title, meeting_date))",
      )
      .eq("person_id", person.id)
      .limit(5000);

    if (voteFilter !== "All") {
      query = query.eq("vote", voteFilter);
    }

    const { data: allVotes, error } = await query;
    const sorted = (allVotes || []).sort((a: any, b: any) => {
      const da = a.motions?.meetings?.meeting_date || "";
      const db = b.motions?.meetings?.meeting_date || "";
      return db.localeCompare(da) || (b.motion_id ?? 0) - (a.motion_id ?? 0);
    });
    const count = sorted.length;
    const votes = sorted.slice(page * pageSize, (page + 1) * pageSize);

    if (error) throw error;

    return {
      person,
      votes: votes || [],
      total: count || 0,
      page,
      pageSize,
      currentFilter: voteFilter,
    };
  } catch (error: any) {
    if (error instanceof Response) throw error;
    console.error("Error loading votes:", error);
    throw new Response("Error loading voting record", { status: 500 });
  }
}

export default function PersonVotes({ loaderData }: Route.ComponentProps) {
  const { person, votes, total, page, pageSize, currentFilter } = loaderData;
  const [searchParams, setSearchParams] = useSearchParams();

  const totalPages = Math.ceil(total / pageSize);

  const handleFilterChange = (filter: string) => {
    setSearchParams({ filter, page: "0" });
  };

  const handlePageChange = (newPage: number) => {
    setSearchParams({ filter: currentFilter, page: newPage.toString() });
  };

  const filters = ["All", "Yes", "No", "Abstain", "Recused"] as const;

  return (
    <div className="min-h-screen bg-zinc-50">
      <div className="container mx-auto max-w-4xl px-4 pt-6 pb-12 md:pt-10">
        <DetailHeader
          className="mb-6"
          back={{ to: personPath(person), label: person.name }}
          meta={[
            <span className="tabular-nums">
              {total.toLocaleString()} recorded {total === 1 ? "vote" : "votes"}
            </span>,
          ]}
          title="Voting record"
          description={
            <span className="flex max-w-2xl items-start gap-1.5 text-sm text-zinc-500">
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-zinc-400" />
              Minutes often name only opposed voters, so unrecorded choices
              stay unknown. This list doesn&apos;t cover every vote cast.
            </span>
          }
        />

        <div className="mb-4">
          <div
            role="tablist"
            aria-label="Filter by vote"
            className="inline-flex max-w-full overflow-x-auto rounded-lg border border-zinc-200 bg-surface p-0.5 shadow-xs"
          >
            {filters.map((f) => (
              <button
                key={f}
                type="button"
                role="tab"
                aria-selected={currentFilter === f}
                onClick={() => handleFilterChange(f)}
                className={cn(
                  "shrink-0 cursor-pointer rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                  currentFilter === f
                    ? "bg-brand-50 text-brand-800"
                    : "text-zinc-600 hover:bg-zinc-50 hover:text-zinc-900",
                )}
              >
                {f}
              </button>
            ))}
          </div>
        </div>

        {votes.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-zinc-200 bg-surface px-6 py-14 text-center">
            <VoteIcon className="mx-auto mb-3 h-8 w-8 text-zinc-300" />
            <p className="text-sm text-zinc-500">
              No individual vote records for this selection. That doesn&apos;t
              mean no votes were cast.
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-zinc-100 rounded-2xl border border-zinc-200 bg-surface shadow-sm">
            {votes.map((v: any) => {
              const meeting = v.motions?.meetings;
              return (
                <li key={v.id} className="flex flex-col gap-2 px-4 py-4 sm:flex-row sm:gap-4 sm:px-5">
                  <div className="shrink-0 pt-0.5 sm:w-16">
                    <VotePill vote={v.vote} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="line-clamp-3 text-sm leading-relaxed text-zinc-800">
                      {v.motions?.plain_english_summary || v.motions?.text_content || "Motion text unavailable"}
                    </p>
                    <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
                      <Link
                        to={meetingPath({ id: v.motions?.meeting_id, slug: (meeting as any)?.slug })}
                        className="text-xs text-zinc-500 hover:text-brand-700"
                      >
                        <span className="tabular-nums">
                          {formatDate(meeting?.meeting_date, {
                            year: "numeric",
                            month: "short",
                            day: "numeric",
                          })}
                        </span>
                        {meeting?.title && (
                          <>
                            <span className="mx-1.5 text-zinc-300">·</span>
                            {displayTitle(meeting.title)}
                          </>
                        )}
                      </Link>
                      <OutcomeBadge result={v.motions?.result} className="sm:hidden" />
                      {v.recusal_reason && (
                        <span className="text-xs text-zinc-500">
                          — {v.recusal_reason}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="hidden shrink-0 pt-0.5 sm:block">
                    <OutcomeBadge result={v.motions?.result} />
                  </div>
                </li>
              );
            })}
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

function VotePill({ vote }: { vote: string }) {
  const tone =
    vote === "Yes"
      ? "bg-emerald-50 text-emerald-700 ring-emerald-100"
      : vote === "No"
        ? "bg-red-50 text-red-700 ring-red-100"
        : vote === "Recused"
          ? "bg-amber-50 text-amber-800 ring-amber-100"
          : "bg-zinc-100 text-zinc-600 ring-zinc-200";
  return (
    <span
      className={cn(
        "inline-flex rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ring-inset",
        tone,
      )}
    >
      {vote}
    </span>
  );
}
