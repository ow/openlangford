import { SITE_NAME } from "../lib/site-name";
import { electionPath } from "../lib/paths";
import { DEFAULT_MUNICIPALITY } from "../lib/site-config";
import type { Route } from "./+types/elections";
import { getElections } from "../services/elections";
import { getSupabaseAdminClient } from "../lib/supabase.server";
import { Link, useRouteLoaderData } from "react-router";
import type { Municipality } from "../lib/types";
import { Gavel, ChevronRight, Calendar, ExternalLink } from "lucide-react";
import { PageHeader } from "../components/ui/page-header";
import { Badge } from "../components/ui/badge";
import { formatDate } from "../lib/utils";
import { ogImageUrl, ogUrl } from "../lib/og";

export const meta: Route.MetaFunction = () => {
  return [
    { title: `Elections | ${SITE_NAME}` },
    { name: "description", content: `Historical election results and candidate data for ${DEFAULT_MUNICIPALITY.short_name}` },
    { property: "og:title", content: `Elections | ${SITE_NAME}` },
    { property: "og:description", content: `Historical election results and candidate data for ${DEFAULT_MUNICIPALITY.short_name}` },
    { property: "og:type", content: "website" },
    { property: "og:url", content: ogUrl("/elections") },
    { property: "og:image", content: ogImageUrl("Elections Archive", { type: "election" }) },
    { property: "og:image:width", content: "1200" },
    { property: "og:image:height", content: "630" },
    { name: "twitter:card", content: "summary_large_image" },
  ];
};

export async function loader() {
  try {
    const supabase = getSupabaseAdminClient();
    const elections = await getElections(supabase);
    return { elections };
  } catch (error) {
    console.error("Error fetching elections:", error);
    return { elections: [] };
  }
}

function resultsStatus(election: any, totalCandidates: number) {
  if (totalCandidates === 0)
    return { label: "Results not loaded", variant: "muted" as const };
  if (election.results_status === "preliminary")
    return { label: "Preliminary results", variant: "warning" as const };
  if (election.results_status === "official")
    return { label: "Official results", variant: "success" as const };
  return { label: "Results pending", variant: "muted" as const };
}

export default function Elections({ loaderData }: Route.ComponentProps) {
  const { elections } = loaderData;
  const rootData = useRouteLoaderData("root") as { municipality?: Municipality } | undefined;
  const shortName = rootData?.municipality?.short_name || DEFAULT_MUNICIPALITY.short_name;

  return (
    <div className="min-h-screen bg-zinc-50">
      <div className="container mx-auto max-w-5xl px-4 py-12">
        <PageHeader
          title="Elections"
          icon={Gavel}
          description={`Local election results and candidates in ${shortName}.`}
        />

        {elections.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-zinc-200 bg-surface p-12 text-center text-sm text-zinc-500">
            No elections have been recorded yet.
          </div>
        ) : (
          <ul className="divide-y divide-zinc-100 overflow-hidden rounded-2xl border border-zinc-200 bg-surface shadow-sm">
            {elections.map((election: any) => {
              const totalCandidates =
                election.election_offices?.reduce(
                  (acc: number, office: any) =>
                    acc + (office.candidacies?.length || 0),
                  0,
                ) || 0;
              const electedCount =
                election.election_offices?.reduce(
                  (acc: number, office: any) =>
                    acc +
                    (office.candidacies?.filter((c: any) => c.is_elected)
                      .length || 0),
                  0,
                ) || 0;
              const status = resultsStatus(election, totalCandidates);

              return (
                <li
                  key={election.id}
                  className="group relative flex items-center gap-4 px-5 py-5 transition-colors hover:bg-zinc-50 sm:px-6"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="text-lg font-bold tracking-tight text-zinc-900 group-hover:text-brand-700">
                        <Link
                          to={electionPath(election)}
                          className="after:absolute after:inset-0"
                        >
                          {election.name}
                        </Link>
                      </h2>
                      <Badge variant={status.variant}>{status.label}</Badge>
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-zinc-500">
                      <span className="inline-flex items-center gap-1.5">
                        <Calendar className="h-3.5 w-3.5" aria-hidden="true" />
                        {formatDate(election.election_date)}
                      </span>
                      <span>{election.classification || "General"} election</span>
                      {totalCandidates > 0 ? (
                        <span className="tabular-nums">
                          {totalCandidates} candidates ·{" "}
                          {electedCount}{" "}
                          {election.results_status === "preliminary"
                            ? "leading"
                            : "elected"}
                        </span>
                      ) : (
                        <span>Candidate results not yet added</span>
                      )}
                      {election.source_url && (
                        <a
                          href={election.source_url}
                          target="_blank"
                          rel="noreferrer"
                          className="relative z-10 inline-flex items-center gap-1 text-brand-700 hover:text-brand-800 hover:underline"
                        >
                          Source
                          <ExternalLink className="h-3 w-3" aria-hidden="true" />
                        </a>
                      )}
                    </div>
                  </div>
                  <ChevronRight
                    className="h-5 w-5 shrink-0 text-zinc-300 transition-transform group-hover:translate-x-0.5 group-hover:text-brand-600"
                    aria-hidden="true"
                  />
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
