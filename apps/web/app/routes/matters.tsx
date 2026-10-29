import { getMunicipality } from "../services/municipality";
import { cachedCompute, HOURLY_SHARED } from "../services/computed-cache.server";
import { timed } from "../lib/server-timing.server";
import { matterPath } from "../lib/paths";
import { DEFAULT_MUNICIPALITY } from "../lib/site-config";
import type { Route } from "./+types/matters";
import { getMatters } from "../services/matters";
import { getSupabaseAdminClient } from "../lib/supabase.server";
import { DEGRADED_HEADERS, forwardCacheControl } from "../lib/degraded-response";
import { Link, data as routeData, redirect, useFetcher, useRouteLoaderData, useSearchParams, type ShouldRevalidateFunctionArgs } from "react-router";
import { pageMeta } from "../lib/page-meta";
import { breadcrumbList, jsonLd } from "../lib/structured-data";
import type { Municipality } from "../lib/types";
import {
  FileText,
  ChevronRight,
  Search,
  Filter,
  Tag,
  Calendar,
  Book,
  MapPin,
} from "lucide-react";
import { Badge } from "../components/ui/badge";
import { useState, useMemo, useRef, useEffect } from "react";
import { formatDate, cn } from "../lib/utils";
import { PageHeader } from "../components/ui/page-header";
import { documentImageUrl } from "../lib/document-images.server";
import { displayTitle, matterTitle } from "../lib/display-text";
import { NativeSelect } from "../components/ui/native-select";
import { FilterBar } from "../components/ui/filter-bar";
import { SearchField } from "../components/ui/search-field";
import { MattersMap } from "../components/matters-map";
import type { Matter } from "../lib/types";
import { ogImageUrl, ogUrl } from "../lib/og";

export const meta: Route.MetaFunction = ({ data }) => {
  const page = data?.page || 1;
  const pageCount = data?.pageCount || 1;
  const total = data?.total || 0;
  const description = `${total ? `${total.toLocaleString("en-CA")} ` : ""}${DEFAULT_MUNICIPALITY.short_name} council matters: rezonings, development permits, bylaws and recurring items, each traced through every meeting, motion and vote.${page > 1 ? ` Page ${page} of ${pageCount}.` : ""}`;
  return [
    ...pageMeta(`Langford Council Matters${page > 1 ? ` — Page ${page}` : ""}`, description, mattersPagePath(page), "website", {
      image: ogImageUrl("Council Matters", { type: "matter" }),
    }),
    ...(page > 1 ? [{ tagName: "link", rel: "prev", href: ogUrl(mattersPagePath(page - 1)) }] : []),
    ...(page < pageCount ? [{ tagName: "link", rel: "next", href: ogUrl(mattersPagePath(page + 1)) }] : []),
    jsonLd(breadcrumbList([["Matters", "/matters"]])),
  ];
};

const PAGE_SIZE = 50;
const PROCEDURAL_TITLES = new Set(["call to order", "approval of agenda", "adjournment", "question period", "termination"]);
const mattersPagePath = (page: number) => (page > 1 ? `/matters?page=${page}` : "/matters");

/** The status filter's buckets; counted server-side so the paginated view needn't ship every matter. */
function statusCounts(matters: { status: string }[]) {
  return {
    All: matters.length,
    Active: matters.filter((m) => m.status === "Active").length,
    Completed: matters.filter((m) => ["Adopted", "Completed"].includes(m.status)).length,
    Inactive: matters.filter((m) => ["Inactive", "Denied", "Repealed"].includes(m.status)).length,
  };
}

/**
 * The default view is server-paginated (?page=N, 50 a page, plain links) so every matter is a
 * crawlable link and the payload stays small. Searching (?q=, or ?all=1, which the page fetches once
 * a filter or the map is used) returns the whole list for client-side filtering.
 */
export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const complete = url.searchParams.has("q") || url.searchParams.get("all") === "1";
  const rawPage = url.searchParams.get("page");
  const requested = rawPage === null ? 1 : Number(rawPage);
  if (!Number.isInteger(requested) || requested < 1) throw redirect("/matters", 301);
  let all: Matter[];
  let failed = false;
  try {
    const supabase = getSupabaseAdminClient();
    const municipality = await getMunicipality(supabase);
    // Building the list joins every matter's agenda items (~4s); it only changes on ingest.
    all = ((await timed("matters-list", cachedCompute(`matters-list:${municipality.id}`, () => getMatters(supabase, municipality), HOURLY_SHARED))) as Matter[])
      .filter((m) => !PROCEDURAL_TITLES.has(m.title.toLowerCase()));
  } catch (error) {
    console.error("Error fetching matters:", error);
    all = [];
    failed = true;
  }
  const pageCount = Math.max(1, Math.ceil(all.length / PAGE_SIZE));
  if (all.length && requested > pageCount) throw new Response("Not Found", { status: 404 });
  const page = Math.min(requested, pageCount);
  const shown = complete ? all : all.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const result = {
    // Lead picture picked from the staff reports, as a thumbnail in the list.
    matters: shown.map((m: any) => ({ ...m, image_url: documentImageUrl(m.lead_image_key), lead_image_key: undefined })) as Matter[],
    complete,
    page,
    pageCount,
    total: all.length,
    counts: statusCounts(all),
    categories: ["All", ...Array.from(new Set(all.map((m) => m.category || "General"))).sort()],
  };
  return failed ? routeData(result, { headers: DEGRADED_HEADERS }) : result;
}

export const headers = forwardCacheControl;

/** Typing in the search box rewrites ?q= on every keystroke; only a page change needs new data. */
export function shouldRevalidate({ currentUrl, nextUrl, formMethod, defaultShouldRevalidate }: ShouldRevalidateFunctionArgs) {
  if (formMethod || currentUrl.pathname !== nextUrl.pathname) return defaultShouldRevalidate;
  return currentUrl.searchParams.get("page") !== nextUrl.searchParams.get("page");
}

function PageLinks({ page, pageCount }: { page: number; pageCount: number }) {
  if (pageCount <= 1) return null;
  const pages = [...new Set([1, page - 2, page - 1, page, page + 1, page + 2, pageCount])]
    .filter((n) => n >= 1 && n <= pageCount)
    .sort((a, b) => a - b);
  const link = "inline-flex min-h-9 min-w-9 items-center justify-center rounded-lg border px-3 text-sm font-semibold tabular-nums transition-colors";
  const idle = "border-zinc-200 bg-surface text-zinc-700 hover:border-brand-300 hover:text-brand-700";
  return (
    <nav aria-label="Matters pages" className="mt-6 flex flex-wrap items-center justify-center gap-2">
      {page > 1 && <Link to={mattersPagePath(page - 1)} rel="prev" className={cn(link, idle)}>Previous</Link>}
      {pages.map((n, i) => (
        <span key={n} className="contents">
          {i > 0 && n - pages[i - 1] > 1 && <span className="px-1 text-zinc-400" aria-hidden="true">…</span>}
          <Link
            to={mattersPagePath(n)}
            aria-current={n === page ? "page" : undefined}
            className={cn(link, n === page ? "border-brand-600 bg-brand-600 text-white" : idle)}
          >
            {n}
          </Link>
        </span>
      ))}
      {page < pageCount && <Link to={mattersPagePath(page + 1)} rel="next" className={cn(link, idle)}>Next</Link>}
    </nav>
  );
}

export default function Matters({ loaderData }: Route.ComponentProps) {
  const { page, pageCount, total, counts, categories } = loaderData;
  // The whole list, once filtering or the map needs it: in the loader data for ?q=, else fetched once.
  const everything = useFetcher<typeof loader>();
  const fullList = loaderData.complete ? loaderData.matters : everything.data?.matters ?? null;
  const matters = fullList ?? loaderData.matters;
  const rootData = useRouteLoaderData("root") as { municipality?: Municipality } | undefined;
  const municipality = rootData?.municipality;
  const [searchParams, setSearchParams] = useSearchParams();
  const [filterText, setFilterText] = useState(searchParams.get("q") || "");
  const [statusFilter, setStatusFilter] = useState("All");
  const [categoryFilter, setCategoryFilter] = useState("All");
  const [viewMode, setViewMode] = useState<"list" | "map">("list");
  const [activeAddress, setActiveAddress] = useState<string | null>(null);
  const [focusedLocation, setFocusedLocation] = useState<
    { lat: number; lng: number } | undefined
  >();
  const [showMap, setShowMap] = useState(true);
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const sidebarRef = useRef<HTMLUListElement>(null);
  const addressRefs = useRef<Record<string, HTMLElement | null>>({});

  const filtering = !!filterText || statusFilter !== "All" || categoryFilter !== "All" || viewMode === "map";
  // Unfiltered list view: the server's page, with plain page links.
  const paginated = !filtering && !loaderData.complete;
  useEffect(() => {
    if (filtering && !fullList && everything.state === "idle" && !everything.data) everything.load("/matters?all=1");
  }, [filtering, fullList, everything]);

  const filteredMatters = useMemo(() => {
    let result = matters;

    if (categoryFilter !== "All") {
      result = result.filter((m) => m.category === categoryFilter);
    }

    if (statusFilter !== "All") {
      if (statusFilter === "Active") {
        result = result.filter((m) => m.status === "Active");
      } else if (statusFilter === "Completed") {
        result = result.filter((m) =>
          ["Adopted", "Completed"].includes(m.status),
        );
      } else if (statusFilter === "Inactive") {
        result = result.filter((m) =>
          ["Inactive", "Denied", "Repealed"].includes(m.status),
        );
      }
    }

    if (filterText) {
      const lower = filterText.toLowerCase();
      result = result.filter(
        (m) => {
          const meta = (m as any).meta && typeof (m as any).meta === "object"
            ? (m as any).meta
            : {};
          const aliases = Array.isArray(meta.aliases) ? meta.aliases : [];
          const searchable = [
            m.title,
            m.identifier,
            m.category,
            (m as any).description,
            (m as any).plain_english_summary,
            meta.entity_cluster,
            ...aliases,
            ...(m.addresses || []),
          ]
            .filter(Boolean)
            .join(" ")
            .toLowerCase();
          return searchable.includes(lower);
        },
      );
    }

    return result;
  }, [matters, filterText, statusFilter, categoryFilter]);

  // Group by address for Address View
  const mattersByAddress = useMemo(() => {
    const grouped: Record<string, typeof matters> = {};
    const noAddress: typeof matters = [];

    filteredMatters.forEach((matter) => {
      if (!matter.addresses || matter.addresses.length === 0) {
        noAddress.push(matter);
      } else {
        matter.addresses.forEach((addr: string) => {
          if (!grouped[addr]) grouped[addr] = [];
          grouped[addr].push(matter);
        });
      }
    });

    return {
      grouped: Object.entries(grouped).sort((a, b) => a[0].localeCompare(b[0])),
      noAddress,
    };
  }, [filteredMatters]);

  // Only show the map when at least one matter has a geocoded location
  const hasGeocoded = useMemo(
    () =>
      filteredMatters.some((m) =>
        (m.locations || []).some((l: any) => l.lat && l.lng),
      ),
    [filteredMatters],
  );
  const showMapPanel = showMap && hasGeocoded;
  const showMapView = viewMode === "map" && showMapPanel;

  const handleAddressClick = (address: string, items: typeof matters) => {
    setActiveAddress(address);
    // Find a location for this address in the linked items
    const location = items
      .flatMap((m) => m.locations || [])
      .find((l) => l.address === address);
    if (location) {
      setFocusedLocation({ lat: location.lat, lng: location.lng });
    }
  };

  const handleMarkerClick = (matter: Matter, address?: string) => {
    const addr = address || matter.addresses?.[0];
    if (addr) {
      setActiveAddress(addr);
      setFocusedLocation(undefined); // Clear focus so user can still pan if they want, or keep it synced?
      // Let's not clear it, so it stays centered if they click.
      if (addressRefs.current[addr]) {
        addressRefs.current[addr]?.scrollIntoView({
          behavior: "smooth",
          block: "nearest",
        });
      }
    }
  };

  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
  }, [filterText, statusFilter, categoryFilter]);

  // Status tabs only help when matters actually spread across statuses
  const statusTabs = [
    { value: "All", label: "All", count: counts.All },
    { value: "Active", label: "Active", count: counts.Active },
    { value: "Completed", label: "Adopted / completed", count: counts.Completed },
    { value: "Inactive", label: "Inactive / denied", count: counts.Inactive },
  ];
  const showStatusTabs =
    statusTabs.filter((t) => t.value !== "All" && t.count > 0).length > 1;

  const statusBadge = (status: string) => {
    if (status === "Active") return null;
    if (["Adopted", "Completed"].includes(status))
      return <Badge variant="success">{status}</Badge>;
    if (["Denied", "Repealed"].includes(status))
      return <Badge variant="danger">{status}</Badge>;
    return <Badge variant="muted">{status}</Badge>;
  };


  return (
    <div className="min-h-screen bg-zinc-50">
      <div
        className={cn(
          "container mx-auto max-w-5xl px-4 py-12",
          showMapView && "grid grid-cols-1 gap-6 lg:grid-cols-12",
        )}
      >
        <PageHeader
          className={showMapView ? "pb-0 lg:col-span-12" : undefined}
          title="Matters"
          icon={Tag}
          description="Bylaws, development applications and recurring items, tracked as they move through council."
          actions={
            <div className="flex items-center gap-1 rounded-lg bg-zinc-200/60 p-1">
              <button
                onClick={() => setViewMode("list")}
                className={cn(
                  "flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-semibold transition-colors",
                  viewMode === "list"
                    ? "bg-surface text-zinc-900 shadow-sm"
                    : "text-zinc-500 hover:text-zinc-800",
                )}
              >
                List
              </button>
              <button
                onClick={() => setViewMode("map")}
                className={cn(
                  "flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-semibold transition-colors",
                  viewMode === "map"
                    ? "bg-surface text-zinc-900 shadow-sm"
                    : "text-zinc-500 hover:text-zinc-800",
                )}
              >
                Map
              </button>
            </div>
          }
        />

        {/* One map instance: first on mobile, beside the address list on desktop. */}
        {showMapView && (
          <div className="row-start-2 lg:col-span-7 lg:col-start-6 lg:row-start-3">
            <MattersMap
              matters={filteredMatters}
              onMarkerClick={handleMarkerClick}
              activeLocation={focusedLocation}
              selectedAddress={activeAddress}
              mapCenter={municipality?.map_center_lat && municipality?.map_center_lng ? { lat: municipality.map_center_lat, lng: municipality.map_center_lng } : undefined}
            />
          </div>
        )}

        <FilterBar
          className={showMapView ? "row-start-3 mb-0 lg:col-span-12 lg:row-start-2" : undefined}
          search={
            <SearchField
              aria-label="Search matters"
              placeholder="Search by title, bylaw number or address"
              value={filterText}
              onValueChange={(value) => {
                setFilterText(value);
                const next = new URLSearchParams(searchParams);
                if (value.trim()) next.set("q", value);
                else next.delete("q");
                setSearchParams(next, { replace: true, preventScrollReset: true });
              }}
            />
          }
          controls={
            <>
              <NativeSelect
                aria-label="Category"
                className="min-w-0 flex-1 sm:w-44 sm:flex-none"
                value={categoryFilter}
                onChange={(e) => setCategoryFilter(e.currentTarget.value)}
              >
                {categories.map((cat) => (
                  <option key={cat} value={cat}>
                    {cat === "All" ? "All categories" : cat}
                  </option>
                ))}
              </NativeSelect>
              {showStatusTabs && (
                <NativeSelect
                  aria-label="Status"
                  className="min-w-0 flex-1 sm:w-48 sm:flex-none"
                  value={statusFilter}
                  onChange={(e) => setStatusFilter(e.currentTarget.value)}
                >
                  {statusTabs
                    .filter((t) => t.value === "All" || t.count > 0)
                    .map((t) => (
                      <option key={t.value} value={t.value}>
                        {t.value === "All" ? "Any status" : t.label} ({t.count.toLocaleString()})
                      </option>
                    ))}
                </NativeSelect>
              )}
            </>
          }
          status={
            filtering && !fullList ? (
              <span>Loading all matters…</span>
            ) : (
              <>
                <span className="font-semibold text-zinc-900">
                  {(paginated ? total : filteredMatters.length).toLocaleString()}
                </span>{" "}
                {(paginated ? total : filteredMatters.length) === 1 ? "matter" : "matters"}
                {paginated && pageCount > 1 && <span className="text-zinc-500"> · page {page} of {pageCount}</span>}
              </>
            )
          }
        />

        <div
          className={cn(
            "grid gap-6",
            showMapView && "row-start-4 lg:col-span-5 lg:col-start-1 lg:row-start-3",
          )}
        >
          {filteredMatters.length === 0 ? (
            <div className="text-center py-24 bg-surface rounded-2xl border border-dashed border-zinc-200 lg:col-span-12">
              <Filter className="h-12 w-12 text-zinc-200 mx-auto mb-4" />
              <p className="text-zinc-500 text-lg">
                No matters match your search.
              </p>
            </div>
          ) : viewMode === "list" ? (
            <div>
              <ul className="overflow-hidden rounded-2xl border border-zinc-200 bg-surface shadow-sm divide-y divide-zinc-100">
                {(paginated ? filteredMatters : filteredMatters.slice(0, visibleCount)).map((matter) => {
                  const bylawLabel =
                    matter.bylaw &&
                    !matter.identifier?.toLowerCase().includes("bylaw")
                      ? matter.bylaw.bylaw_number
                        ? `Bylaw ${matter.bylaw.bylaw_number}`
                        : "Bylaw"
                      : null;
                  return (
                    <li key={matter.id}>
                      <Link
                        to={matterPath(matter)}
                        className="group flex items-start gap-4 px-5 py-4 transition-colors hover:bg-zinc-50"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                            <h3 className="text-base font-semibold leading-snug text-zinc-900 group-hover:text-brand-700">
                              {matterTitle(matter)}
                            </h3>
                            {statusBadge(matter.status)}
                          </div>
                          <p className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-zinc-500">
                            <span className="font-medium text-zinc-600">
                              {matter.category || "General"}
                            </span>
                            {matter.identifier && (
                              <>
                                <span aria-hidden="true">·</span>
                                <span className="tabular-nums text-zinc-600">
                                  {matter.identifier}
                                </span>
                              </>
                            )}
                            {bylawLabel && (
                              <>
                                <span aria-hidden="true">·</span>
                                <span className="inline-flex items-center gap-1">
                                  <Book className="h-3 w-3" />
                                  {bylawLabel}
                                </span>
                              </>
                            )}
                            {(matter as any).letter_count > 0 && (
                              <>
                                <span aria-hidden="true">·</span>
                                <span className="tabular-nums">
                                  {(matter as any).letter_count} {(matter as any).letter_count === 1 ? "letter" : "letters"}
                                </span>
                              </>
                            )}
                            {matter.addresses?.slice(0, 3).map((addr: string) => (
                              <span key={addr} className="inline-flex items-center gap-1">
                                <span aria-hidden="true">·</span>
                                <MapPin className="h-3 w-3" />
                                {addr}
                              </span>
                            ))}
                          </p>
                          {(matter.plain_english_summary || matter.description) && (
                            <p className="mt-1.5 max-w-[75ch] text-sm leading-relaxed text-zinc-600 line-clamp-2">
                              {matter.plain_english_summary || matter.description}
                            </p>
                          )}
                        </div>
                        {(matter as any).image_url && (
                          <img
                            src={(matter as any).image_url}
                            alt=""
                            loading="lazy"
                            className="hidden h-16 w-24 shrink-0 self-center rounded-lg border border-zinc-200 object-cover sm:block"
                          />
                        )}
                        <div className="flex shrink-0 items-center gap-3 self-center">
                          {matter.last_seen && (
                            <span className="hidden text-xs tabular-nums text-zinc-500 sm:inline">
                              {formatDate(matter.last_seen, {
                                month: "short",
                                day: "numeric",
                                year: "numeric",
                              })}
                            </span>
                          )}
                          <ChevronRight className="h-5 w-5 text-zinc-300 group-hover:text-brand-600" />
                        </div>
                      </Link>
                    </li>
                  );
                })}
              </ul>
              {paginated && <PageLinks page={page} pageCount={pageCount} />}
              {!paginated && visibleCount < filteredMatters.length && (
                <div className="mt-6 flex justify-center">
                  <button
                    onClick={() => setVisibleCount((n) => n + PAGE_SIZE)}
                    className="rounded-full border border-zinc-200 bg-surface px-5 py-2 text-sm font-semibold text-zinc-700 shadow-sm transition-colors hover:border-brand-300 hover:text-brand-700"
                  >
                    Show more
                    <span className="ml-1.5 font-normal text-zinc-500">
                      ({(filteredMatters.length - visibleCount).toLocaleString()} remaining)
                    </span>
                  </button>
                </div>
              )}
            </div>
          ) : mattersByAddress.grouped.length === 0 && !hasGeocoded ? (
            <div className="rounded-2xl border border-dashed border-zinc-300 bg-surface/60 p-5 text-sm text-zinc-500 lg:col-span-12">
              None of these {filteredMatters.length.toLocaleString()}{" "}
              {filteredMatters.length === 1 ? "matter has" : "matters have"} a
              mapped address yet. Addresses appear here once they've been
              extracted and geocoded from agenda documents.{" "}
              <button
                type="button"
                onClick={() => setViewMode("list")}
                className="font-medium text-brand-700 hover:underline"
              >
                Browse the list instead
              </button>
              .
            </div>
          ) : (
            <>
              {/* Address list for map view */}
              <div
                className="overflow-hidden rounded-2xl border border-zinc-200 bg-surface shadow-sm"
              >
                <div className="flex items-center justify-between gap-3 border-b border-zinc-100 px-4 py-3">
                  <h2 className="text-sm font-semibold text-zinc-900">
                    {mattersByAddress.grouped.length.toLocaleString()}{" "}
                    <span className="font-normal text-zinc-500">
                      {mattersByAddress.grouped.length === 1 ? "address" : "addresses"}
                    </span>
                  </h2>
                  {hasGeocoded && (
                    <button
                      type="button"
                      onClick={() => setShowMap(!showMap)}
                      className="text-xs font-medium text-zinc-500 transition-colors hover:text-brand-700"
                    >
                      {showMap ? "Hide map" : "Show map"}
                    </button>
                  )}
                </div>

                {!hasGeocoded && (
                  <p className="border-b border-zinc-100 bg-zinc-50/60 px-4 py-2.5 text-xs text-zinc-500">
                    These addresses haven't been placed on the map yet.
                  </p>
                )}

                <ul
                  ref={sidebarRef}
                  className={cn(
                    "divide-y divide-zinc-100 overflow-y-auto",
                    showMapPanel ? "max-h-[420px] lg:max-h-[560px]" : "",
                  )}
                >
                  {mattersByAddress.grouped.map(([address, items]) => {
                    const isActive = activeAddress === address;
                    return (
                      <li
                        key={address}
                        ref={(el) => {
                          addressRefs.current[address] = el;
                        }}
                        className={cn(
                          "border-l-2 px-4 py-3 transition-colors",
                          isActive
                            ? "border-l-brand-600 bg-brand-50/60"
                            : "border-l-transparent",
                        )}
                      >
                        <button
                          type="button"
                          data-address-row
                          onClick={() => handleAddressClick(address, items)}
                          aria-pressed={isActive}
                          className="flex w-full items-baseline justify-between gap-3 text-left"
                        >
                          <span
                            className={cn(
                              "text-sm font-semibold",
                              isActive ? "text-brand-800" : "text-zinc-900 hover:text-brand-700",
                            )}
                          >
                            {address}
                          </span>
                          <span className="shrink-0 text-xs tabular-nums text-zinc-500">
                            {items.length} {items.length === 1 ? "matter" : "matters"}
                          </span>
                        </button>
                        <ul className="mt-1 space-y-0.5">
                          {items.map((matter) => (
                            <li key={matter.id}>
                              <Link
                                to={matterPath(matter)}
                                className="group block py-0.5 text-sm leading-snug text-zinc-700"
                              >
                                <span className="group-hover:text-brand-700 group-hover:underline">
                                  {matterTitle(matter)}
                                </span>
                                {matter.category && (
                                  <span className="text-xs text-zinc-500">
                                    {" "}· {matter.category}
                                  </span>
                                )}
                              </Link>
                            </li>
                          ))}
                        </ul>
                      </li>
                    );
                  })}
                </ul>

                {mattersByAddress.noAddress.length > 0 && (
                  <p className="border-t border-zinc-100 px-4 py-2.5 text-xs text-zinc-500">
                    {mattersByAddress.noAddress.length.toLocaleString()} other{" "}
                    {mattersByAddress.noAddress.length === 1 ? "matter has" : "matters have"} no
                    address.
                  </p>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
