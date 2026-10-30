import { bylawPath, matterPath } from "../lib/paths";
import { DEFAULT_MUNICIPALITY } from "../lib/site-config";
import type { Route } from "./+types/bylaws";
import { getBylaws, getPolicies } from "../services/bylaws";
import { getSupabaseAdminClient } from "../lib/supabase.server";
import { cachedCompute, HOURLY_SHARED } from "../services/computed-cache.server";
import { Link, data as routeData, useRouteLoaderData, useSearchParams, type ShouldRevalidateFunctionArgs } from "react-router";
import { DEGRADED_HEADERS, forwardCacheControl } from "../lib/degraded-response";
import type { Bylaw, Municipality } from "../lib/types";
import { Book, Search, FileText, ChevronRight, History } from "lucide-react";
import { Badge } from "../components/ui/badge";
import { Input } from "../components/ui/input";
import { PageHeader } from "../components/ui/page-header";
import { SectionHeading } from "../components/ui/section-heading";
import { useState, useMemo } from "react";
import { displayTitle, matterTitle } from "../lib/display-text";
import { bylawLead, bylawStatus } from "../lib/bylaw-summary";
import { groupPolicies, isRetiredPolicy, policyNumbers, type PolicyRow } from "../lib/policies";
import { matterStatusVariant } from "../lib/matter-status";
import { cn, formatDate } from "../lib/utils";
import { ogImageUrl } from "../lib/og";
import { pageMeta } from "../lib/page-meta";
import { breadcrumbList, jsonLd } from "../lib/structured-data";

export const meta: Route.MetaFunction = () => {
  return [
    ...pageMeta(
      "Langford Bylaws & Policies",
      `${DEFAULT_MUNICIPALITY.short_name} bylaws and council policies, from zoning and development to fees, parks, purchasing and traffic: plain-language summaries, full text, amendments and the council matters behind each.`,
      "/bylaws",
      "website",
      { image: ogImageUrl("Bylaws and policies", { subtitle: "Langford's rules in plain language, with full text and amendments", type: "council" }) },
    ),
    jsonLd(breadcrumbList([["Bylaws", "/bylaws"]])),
  ];
};

export async function loader() {
  try {
    const supabase = getSupabaseAdminClient();
    // Both lists only change when the pipeline runs; errors throw, so they are never cached.
    return await cachedCompute(
      "bylaws-index:v2",
      async () => {
        const [bylaws, policies] = await Promise.all([getBylaws(supabase), getPolicies(supabase)]);
        return { bylaws, policies };
      },
      HOURLY_SHARED,
    );
  } catch (error) {
    console.error("Error fetching bylaws and policies:", error);
    return routeData({ bylaws: [] as Bylaw[], policies: [] as PolicyRow[] }, { headers: DEGRADED_HEADERS });
  }
}

export const headers = forwardCacheControl;

/** Switching between the Bylaws and Policies tabs (?view=) reuses the data already loaded. */
export function shouldRevalidate({ currentUrl, nextUrl, formMethod, defaultShouldRevalidate }: ShouldRevalidateFunctionArgs) {
  if (formMethod || currentUrl.pathname !== nextUrl.pathname) return defaultShouldRevalidate;
  return false;
}

type View = "bylaws" | "policies";

export default function Bylaws({ loaderData }: Route.ComponentProps) {
  const { bylaws, policies } = loaderData;
  const rootData = useRouteLoaderData("root") as { municipality?: Municipality } | undefined;
  const municipalityName = rootData?.municipality?.name || DEFAULT_MUNICIPALITY.name;
  const [searchParams] = useSearchParams();
  const view: View = searchParams.get("view") === "policies" ? "policies" : "bylaws";
  const [filterText, setFilterText] = useState("");
  const lower = filterText.trim().toLowerCase();

  const filteredBylaws = useMemo(() => {
    if (!lower) return bylaws;
    return bylaws.filter(
      (b) =>
        b.title.toLowerCase().includes(lower) ||
        b.bylaw_number?.toLowerCase().includes(lower) ||
        b.plain_english_summary?.toLowerCase().includes(lower),
    );
  }, [bylaws, lower]);

  const filteredPolicies = useMemo(() => {
    const shown = !lower
      ? policies
      : policies.filter((p) =>
          [matterTitle(p), p.title, p.identifier, p.category, p.plain_english_summary]
            .filter(Boolean)
            .some((text) => String(text).toLowerCase().includes(lower)),
        );
    return groupPolicies(shown);
  }, [policies, lower]);

  const hasBylaws = bylaws.length > 0;
  const showSearch = view === "bylaws" ? hasBylaws : policies.length > 0;
  const tabs: { id: View; label: string; count: number; href: string }[] = [
    { id: "bylaws", label: "Bylaws", count: bylaws.length, href: "/bylaws" },
    { id: "policies", label: "Policies", count: policies.length, href: "/bylaws?view=policies" },
  ];

  return (
    <div className="min-h-screen bg-zinc-50">
      <div className="container mx-auto max-w-5xl px-4 pt-6 pb-12 md:pt-10">
        <PageHeader
          title="Bylaws & policies"
          icon={Book}
          description={`The official regulations, plans, and council policies of the ${municipalityName}.`}
          actions={
            showSearch ? (
              <div className="relative w-full md:w-72">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
                <Input
                  placeholder={view === "policies" ? "Search policies" : "Search bylaws"}
                  aria-label={view === "policies" ? "Search policies" : "Search bylaws"}
                  value={filterText}
                  onChange={(e) => setFilterText(e.target.value)}
                  className="bg-surface pl-9"
                />
              </div>
            ) : undefined
          }
        >
          <nav
            aria-label="Bylaws or policies"
            className="inline-flex max-w-full self-start overflow-x-auto rounded-lg border border-zinc-200 bg-surface p-0.5 shadow-xs"
          >
            {tabs.map((tab) => (
              <Link
                key={tab.id}
                to={tab.href}
                replace
                preventScrollReset
                aria-current={view === tab.id ? "page" : undefined}
                className={cn(
                  "shrink-0 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                  view === tab.id ? "bg-brand-50 text-brand-800" : "text-zinc-600 hover:bg-zinc-50 hover:text-zinc-900",
                )}
              >
                {tab.label}
                <span className="ml-1.5 tabular-nums text-zinc-500">{tab.count.toLocaleString()}</span>
              </Link>
            ))}
          </nav>
        </PageHeader>

        {view === "policies" ? (
          <PolicyList groups={filteredPolicies} filterText={filterText} total={policies.length} />
        ) : !hasBylaws ? (
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
          <NoMatches what="bylaws" filterText={filterText} />
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

function NoMatches({ what, filterText }: { what: string; filterText: string }) {
  return (
    <div className="rounded-2xl border border-dashed border-zinc-200 bg-surface px-6 py-16 text-center">
      <Search className="mx-auto mb-3 h-8 w-8 text-zinc-300" />
      <p className="text-sm text-zinc-500">
        No {what} match &ldquo;{filterText}&rdquo;.
      </p>
    </div>
  );
}

function PolicyList({
  groups,
  filterText,
  total,
}: {
  groups: { current: PolicyRow[]; replaced: PolicyRow[] };
  filterText: string;
  total: number;
}) {
  if (total === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-zinc-200 bg-surface px-6 py-16 text-center">
        <FileText className="mx-auto mb-3 h-8 w-8 text-zinc-300" />
        <p className="text-base font-semibold text-zinc-900">No policies yet</p>
      </div>
    );
  }
  if (!groups.current.length && !groups.replaced.length) return <NoMatches what="policies" filterText={filterText} />;
  return (
    <div className="space-y-10">
      {groups.current.length > 0 && (
        <section aria-labelledby="policies-current">
          <p id="policies-current" className="mb-3 text-sm text-zinc-500 tabular-nums">
            {groups.current.length.toLocaleString()} council {groups.current.length === 1 ? "policy" : "policies"}, most
            recently considered first. Policies guide how the City runs; unlike bylaws they are set by council resolution.
          </p>
          <PolicyItems policies={groups.current} />
        </section>
      )}
      {groups.replaced.length > 0 && (
        <section aria-labelledby="policies-replaced">
          <SectionHeading
            title={<span id="policies-replaced">Replaced</span>}
            icon={History}
            description="Repealed, rescinded or superseded policies, kept for the record."
          />
          <PolicyItems policies={groups.replaced} />
        </section>
      )}
    </div>
  );
}

function PolicyItems({ policies }: { policies: PolicyRow[] }) {
  return (
    <ul className="divide-y divide-zinc-100 rounded-2xl border border-zinc-200 bg-surface shadow-sm">
      {policies.map((policy) => {
        const retired = isRetiredPolicy(policy.status);
        const variant = matterStatusVariant(policy.status);
        return (
          <li key={policy.id}>
            <Link
              to={matterPath(policy)}
              className="group flex items-start gap-4 px-4 py-4 transition-colors hover:bg-zinc-50 sm:px-5"
            >
              <div className={cn("min-w-0 flex-1", retired && "opacity-70")}>
                <p className="mb-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-zinc-500">
                  {[
                    policyNumbers(policy.identifier).join(", "),
                    policy.category || null,
                    policy.last_seen
                      ? formatDate(policy.last_seen, { year: "numeric", month: "short", day: "numeric" })
                      : null,
                  ]
                    .filter(Boolean)
                    .map((part, i) => (
                      <span key={i} className="inline-flex items-center gap-1.5 tabular-nums">
                        {i > 0 && <span aria-hidden="true" className="text-zinc-300">·</span>}
                        {part}
                      </span>
                    ))}
                  {variant && policy.status && (
                    <Badge variant={retired ? "muted" : variant} className="ml-0.5">
                      {policy.status}
                    </Badge>
                  )}
                </p>
                <h3
                  className={cn(
                    "text-base font-semibold leading-snug group-hover:text-brand-700",
                    retired ? "text-zinc-600" : "text-zinc-900",
                  )}
                >
                  {matterTitle(policy)}
                </h3>
                {policy.plain_english_summary && (
                  <p className="mt-1 line-clamp-2 text-sm leading-relaxed text-zinc-600">{policy.plain_english_summary}</p>
                )}
                {policy.meta?.status_line && (
                  <p className="mt-1 text-xs text-zinc-500">{policy.meta.status_line}</p>
                )}
              </div>
              <ChevronRight className="mt-1 h-4 w-4 shrink-0 text-zinc-300 transition-colors group-hover:text-brand-600" />
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
