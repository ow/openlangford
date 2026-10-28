import { bylawPath } from "../lib/paths";
import { DEFAULT_MUNICIPALITY } from "../lib/site-config";
import type { Route } from "./+types/bylaws";
import { getBylaws } from "../services/bylaws";
import { getSupabaseAdminClient } from "../lib/supabase.server";
import { Link, useRouteLoaderData } from "react-router";
import type { Municipality } from "../lib/types";
import { Book, Search, FileText, ChevronRight } from "lucide-react";
import { Badge } from "../components/ui/badge";
import { Input } from "../components/ui/input";
import { PageHeader } from "../components/ui/page-header";
import { useState, useMemo } from "react";
import { displayTitle } from "../lib/display-text";
import { bylawLead, bylawStatus } from "../lib/bylaw-summary";
import { ogImageUrl } from "../lib/og";
import { pageMeta } from "../lib/page-meta";
import { breadcrumbList, jsonLd } from "../lib/structured-data";

export const meta: Route.MetaFunction = () => {
  return [
    ...pageMeta(
      "Langford Bylaws",
      `${DEFAULT_MUNICIPALITY.short_name} bylaws and policies, from zoning and development to fees, parks and traffic: plain-language summaries, full text, amendments and the council matters behind each.`,
      "/bylaws",
      "website",
      { image: ogImageUrl("Bylaws & Policies", { type: "bylaw" }) },
    ),
    jsonLd(breadcrumbList([["Bylaws", "/bylaws"]])),
  ];
};

export async function loader() {
  try {
    const supabase = getSupabaseAdminClient();
    const bylaws = await getBylaws(supabase);
    return { bylaws };
  } catch (error) {
    console.error("Error fetching bylaws:", error);
    return { bylaws: [] };
  }
}

export default function Bylaws({ loaderData }: Route.ComponentProps) {
  const { bylaws } = loaderData;
  const rootData = useRouteLoaderData("root") as { municipality?: Municipality } | undefined;
  const municipalityName = rootData?.municipality?.name || DEFAULT_MUNICIPALITY.name;
  const [filterText, setFilterText] = useState("");

  const filteredBylaws = useMemo(() => {
    if (!filterText) return bylaws;
    const lower = filterText.toLowerCase();
    return bylaws.filter(
      (b) =>
        b.title.toLowerCase().includes(lower) ||
        b.bylaw_number?.toLowerCase().includes(lower) ||
        b.plain_english_summary?.toLowerCase().includes(lower),
    );
  }, [bylaws, filterText]);

  const hasBylaws = bylaws.length > 0;

  return (
    <div className="min-h-screen bg-zinc-50">
      <div className="container mx-auto max-w-5xl px-4 py-12">
        <PageHeader
          title="Bylaws & policies"
          icon={Book}
          description={`The official regulations, plans, and policies of the ${municipalityName}.`}
          actions={
            hasBylaws ? (
              <div className="relative w-full md:w-72">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
                <Input
                  placeholder="Search bylaws"
                  aria-label="Search bylaws"
                  value={filterText}
                  onChange={(e) => setFilterText(e.target.value)}
                  className="bg-surface pl-9"
                />
              </div>
            ) : undefined
          }
        />

        {!hasBylaws ? (
          <div className="rounded-2xl border border-dashed border-zinc-200 bg-surface px-6 py-16 text-center">
            <FileText className="mx-auto mb-3 h-8 w-8 text-zinc-300" />
            <p className="text-base font-semibold text-zinc-900">
              No bylaws yet
            </p>
            <p className="mx-auto mt-1 max-w-md text-sm text-zinc-500">
              Bylaws haven&apos;t been added for the {municipalityName}. In the
              meantime, bylaw readings and adoptions appear in{" "}
              <Link to="/matters" className="font-medium text-brand-700 hover:text-brand-800">
                matters
              </Link>{" "}
              and{" "}
              <Link to="/meetings" className="font-medium text-brand-700 hover:text-brand-800">
                meeting records
              </Link>
              .
            </p>
          </div>
        ) : filteredBylaws.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-zinc-200 bg-surface px-6 py-16 text-center">
            <Search className="mx-auto mb-3 h-8 w-8 text-zinc-300" />
            <p className="text-sm text-zinc-500">
              No bylaws match &ldquo;{filterText}&rdquo;.
            </p>
          </div>
        ) : (
          <>
            <p className="mb-3 text-sm text-zinc-500 tabular-nums">
              {filteredBylaws.length.toLocaleString()}{" "}
              {filteredBylaws.length === 1 ? "bylaw" : "bylaws"}
            </p>
            <ul className="divide-y divide-zinc-100 rounded-2xl border border-zinc-200 bg-surface shadow-sm">
              {filteredBylaws.map((bylaw) => (
                <li key={bylaw.id}>
                  <Link
                    to={bylawPath(bylaw)}
                    className="group flex items-start gap-4 px-4 py-4 transition-colors hover:bg-zinc-50 sm:px-5"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="mb-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-zinc-500">
                        {[
                          bylaw.bylaw_number ? `No. ${bylaw.bylaw_number}` : null,
                          bylaw.category || null,
                          bylaw.year ? `Adopted ${bylaw.year}` : null,
                          bylawStatus(bylaw.status)?.tone === "danger" ? null : bylawStatus(bylaw.status)?.label,
                        ]
                          .filter(Boolean)
                          .map((part, i) => (
                            <span key={i} className="inline-flex items-center gap-1.5 tabular-nums">
                              {i > 0 && <span aria-hidden="true" className="text-zinc-300">·</span>}
                              {part}
                            </span>
                          ))}
                        {bylawStatus(bylaw.status)?.tone === "danger" && (
                          <Badge variant="danger">{bylawStatus(bylaw.status)?.label}</Badge>
                        )}
                      </p>
                      <h3 className="text-base font-semibold leading-snug text-zinc-900 group-hover:text-brand-700">
                        {displayTitle(bylaw.title)}
                      </h3>
                      {bylawLead(bylaw.plain_english_summary) && (
                        <p className="mt-1 line-clamp-2 text-sm leading-relaxed text-zinc-600">
                          {bylawLead(bylaw.plain_english_summary)}
                        </p>
                      )}
                    </div>
                    <ChevronRight className="mt-1 h-4 w-4 shrink-0 text-zinc-300 transition-colors group-hover:text-brand-600" />
                  </Link>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}
