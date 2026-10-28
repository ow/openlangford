import { DEFAULT_MUNICIPALITY } from "../lib/site-config";
import type { Route } from "./+types/meetings";
import {
  getMeetings,
  getMeetingDateBounds,
  type MeetingStats,
} from "../services/meetings";
import { getMunicipality } from "../services/municipality";
import { getSupabaseAdminClient } from "../lib/supabase.server";
import { getMunicipalityFromMatches } from "../lib/municipality-helpers";
import type { Meeting } from "../lib/types";
import { cn } from "../lib/utils";
import { ogImageUrl } from "../lib/og";
import { pageMeta } from "../lib/page-meta";
import { breadcrumbList, jsonLd } from "../lib/structured-data";

export const meta: Route.MetaFunction = ({ data, matches, location }) => {
  const municipality = getMunicipalityFromMatches(matches);
  const shortName = municipality?.short_name || DEFAULT_MUNICIPALITY.short_name;
  // A year view (/meetings?year=2024) is its own indexable page; the bare list is the current year.
  const yearView = new URLSearchParams(location.search).has("year") && data?.selectedYear !== data?.currentYear ? data?.selectedYear : null;
  const title = yearView ? `Langford Council Meetings in ${yearView}` : "Langford Council Meetings";
  const description = yearView
    ? `Every ${shortName} council and committee meeting in ${yearView}: agendas, minutes, video, decisions and recorded votes.`
    : `Every ${shortName} council and committee meeting: agendas, minutes, video, plain-language summaries, decisions and recorded votes, searchable by year.`;
  return [
    ...pageMeta(title, description, meetingsYearPath(yearView), "website", {
      image: ogImageUrl(yearView ? `${yearView} Council Meetings` : "Council Meetings", { type: "meeting" }),
    }),
    jsonLd(breadcrumbList(yearView ? [["Meetings", "/meetings"], [String(yearView), meetingsYearPath(yearView)]] : [["Meetings", "/meetings"]])),
  ];
};

/** The bare list shows the current year; other years live at ?year=YYYY (self-canonical). */
function meetingsYearPath(year: number | null | undefined, currentYear?: number) {
  return year && year !== currentYear ? `/meetings?year=${year}` : "/meetings";
}
import {
  Link,
  useSearchParams,
  type ShouldRevalidateFunctionArgs,
} from "react-router";
import { useState, useEffect, useMemo, useRef } from "react";
import {
  Search,
  Calendar as CalendarIcon,
  LayoutList,
  X,
  ArrowDownWideNarrow,
  ArrowUpNarrowWide,
} from "lucide-react";
import { MeetingCard } from "../components/meeting-card";
import { PageHeader } from "../components/ui/page-header";
import { NativeSelect } from "../components/ui/native-select";
import { FilterBar } from "../components/ui/filter-bar";
import { SearchField } from "../components/ui/search-field";
import { CalendarView } from "../components/calendar-view";
import {
  meetingPeriod,
  meetingPeriodLabel,
  shiftMeetingPeriod,
} from "../lib/meeting-period";

import { historicalPublicDate, HISTORICAL_PUBLIC_TTL, RECENT_PUBLIC_TTL } from "../lib/public-content-cache";
import { publicData } from "../services/public-data-cache.server";

export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const currentYear = new Date().getFullYear();
  const { year: selectedYear } = meetingPeriod(url.searchParams);

  try {
    const supabase = getSupabaseAdminClient();
    const municipality = await getMunicipality(supabase);
    const [{ meetings, statsMap }, bounds] = await Promise.all([
      publicData(`meetings:${municipality.id}:${selectedYear}`, () => getMeetings(supabase, municipality, {
        startDate: `${selectedYear}-01-01`,
        endDate: `${selectedYear}-12-31`,
      }), (result) => result.statsComplete, historicalPublicDate(`${selectedYear}-12-31`) ? HISTORICAL_PUBLIC_TTL : RECENT_PUBLIC_TTL),
      publicData(`meeting-bounds:${municipality.id}`, () => getMeetingDateBounds(supabase, municipality), () => true, 3600).catch((error) => {
        console.error("Error loading meeting history availability:", error);
        return null;
      }),
    ]);
    return {
      meetings,
      statsMap,
      selectedYear,
      currentYear,
      bounds,
      loadError: false,
    };
  } catch (error) {
    console.error("Error loading meetings data:", error);
    return {
      meetings: [],
      statsMap: {} as Record<number, MeetingStats>,
      selectedYear,
      currentYear,
      bounds: null,
      loadError: true,
    };
  }
}

export function shouldRevalidate({
  currentUrl,
  nextUrl,
}: ShouldRevalidateFunctionArgs) {
  return (
    currentUrl.searchParams.get("year") !== nextUrl.searchParams.get("year")
  );
}

export default function Meetings({ loaderData }: Route.ComponentProps) {
  const { meetings, statsMap, selectedYear, currentYear, bounds, loadError } =
    loaderData;
  const [searchParams, setSearchParams] = useSearchParams();

  const view = searchParams.get("view") || "list";
  const qParam = searchParams.get("q") || "";
  const [searchQuery, setSearchQuery] = useState(qParam);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const typeFilter = searchParams.get("type") || "";
  const sortOrder = searchParams.get("sort") === "asc" ? "asc" : "desc";

  const years = useMemo(() => {
    const yearsArr: number[] = [];
    const first = bounds?.earliest
      ? Number(bounds.earliest.slice(0, 4))
      : currentYear;
    const last = Math.max(
      currentYear,
      Number(bounds?.latest?.slice(0, 4) || currentYear),
    );
    for (let y = last; y >= first; y--) yearsArr.push(y);
    if (!yearsArr.includes(selectedYear)) yearsArr.push(selectedYear);
    yearsArr.sort((a, b) => b - a);
    return yearsArr;
  }, [currentYear, selectedYear, bounds]);

  // Plain links to every year with meeting records, so each year's page is reachable by crawlers.
  const yearsWithMeetings = useMemo(() => {
    const first = Number(bounds?.earliest?.slice(0, 4));
    const last = Number(bounds?.latest?.slice(0, 4));
    if (!first || !last) return [];
    return Array.from({ length: last - first + 1 }, (_, i) => last - i);
  }, [bounds]);

  const meetingTypes = useMemo(() => {
    const types = new Set<string>();
    meetings.forEach((m) => {
      if (m.type) types.add(m.type);
    });
    if (typeFilter) types.add(typeFilter);
    return Array.from(types).sort();
  }, [meetings, typeFilter]);

  const filtered = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const list = meetings.filter((m) => {
      if (typeFilter && m.type !== typeFilter) return false;
      if (q) {
        const hit =
          m.title.toLowerCase().includes(q) ||
          m.summary?.toLowerCase().includes(q) ||
          m.organization?.name?.toLowerCase().includes(q);
        if (!hit) return false;
      }
      return true;
    });
    list.sort((a, b) =>
      sortOrder === "asc"
        ? a.meeting_date.localeCompare(b.meeting_date)
        : b.meeting_date.localeCompare(a.meeting_date),
    );
    return list;
  }, [meetings, searchQuery, typeFilter, sortOrder]);

  // Upcoming meetings get their own section (soonest first); past meetings
  // are grouped by month.
  const { upcoming, pastByMonth } = useMemo(() => {
    const today = new Date().toLocaleDateString("en-CA");
    const upcoming = filtered
      .filter((m) => m.meeting_date >= today && m.status !== "Cancelled")
      .sort((a, b) => a.meeting_date.localeCompare(b.meeting_date));
    const upcomingIds = new Set(upcoming.map((m) => m.id));
    const groups: { key: string; label: string; items: Meeting[] }[] = [];
    for (const m of filtered) {
      if (upcomingIds.has(m.id)) continue;
      const key = m.meeting_date.slice(0, 7);
      let group = groups[groups.length - 1];
      if (!group || group.key !== key) {
        const [y, mo] = key.split("-").map(Number);
        group = {
          key,
          label: new Date(y, mo - 1, 1).toLocaleDateString("en-CA", {
            month: "long",
            year: "numeric",
          }),
          items: [],
        };
        groups.push(group);
      }
      group.items.push(m);
    }
    return { upcoming, pastByMonth: groups };
  }, [filtered]);

  const period = meetingPeriod(searchParams);
  const periodLabel = meetingPeriodLabel(
    selectedYear,
    period.monthly ? period.month : undefined,
  );
  const navigationParams = new URLSearchParams(searchParams);
  if (searchQuery) navigationParams.set("q", searchQuery);
  else navigationParams.delete("q");
  const previous = shiftMeetingPeriod(navigationParams, -1);
  const next = shiftMeetingPeriod(navigationParams, 1);
  const previousPeriod = meetingPeriod(previous);
  const nextPeriod = meetingPeriod(next);
  const previousLabel = meetingPeriodLabel(
    previousPeriod.year,
    period.monthly ? previousPeriod.month : undefined,
  );
  const nextLabel = meetingPeriodLabel(
    nextPeriod.year,
    period.monthly ? nextPeriod.month : undefined,
  );
  const periodKey = period.monthly
    ? `${selectedYear}-${String(period.month).padStart(2, "0")}`
    : String(selectedYear);
  const firstKey = bounds?.earliest?.slice(0, period.monthly ? 7 : 4);
  const now = new Date();
  const todayKey = `${currentYear}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const lastKey = [
    bounds?.latest?.slice(0, period.monthly ? 7 : 4),
    period.monthly ? todayKey : String(currentYear),
  ]
    .filter(Boolean)
    .sort()
    .pop()!;
  const canPrevious = !!firstKey && periodKey > firstKey;
  const canNext = !!firstKey && periodKey < lastKey;
  const historyLink =
    "inline-flex min-h-10 items-center gap-1 rounded-lg border border-zinc-200 px-3 py-2 text-sm font-semibold text-brand-700 hover:bg-brand-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500";

  const resultCount = period.monthly
    ? filtered.filter((meeting) =>
        meeting.meeting_date.startsWith(
          `${selectedYear}-${String(period.month).padStart(2, "0")}`,
        ),
      ).length
    : filtered.length;
  const todayParams = new URLSearchParams(navigationParams);
  todayParams.set("year", String(currentYear));
  todayParams.set("month", String(now.getMonth() + 1));

  const hasActiveFilters = !!(typeFilter || searchQuery);

  const updateFilters = (updates: Record<string, string | null>) => {
    const next = new URLSearchParams(searchParams);
    Object.entries(updates).forEach(([key, value]) => {
      if (value === null || value === "") next.delete(key);
      else next.set(key, value);
    });
    setSearchParams(next, { preventScrollReset: true });
  };

  useEffect(() => {
    setSearchQuery(qParam);
  }, [qParam]);

  useEffect(() => {
    searchTimer.current = setTimeout(() => {
      if (searchQuery !== qParam) updateFilters({ q: searchQuery || null });
    }, 300);
    return () => clearTimeout(searchTimer.current);
  }, [searchQuery, qParam]);

  const clearFilters = () => {
    setSearchQuery("");
    updateFilters({ q: null, type: null });
  };

  const viewButton = (
    value: "list" | "calendar",
    Icon: typeof LayoutList,
    label: string,
  ) => (
    <button
      onClick={() => updateFilters({ view: value === "list" ? null : value })}
      aria-pressed={view === value}
      className={cn(
        "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-semibold transition-colors",
        view === value
          ? "bg-surface text-zinc-900 shadow-sm"
          : "text-zinc-500 hover:text-zinc-800",
      )}
    >
      {label}
    </button>
  );

  const group = (
    key: string,
    label: string,
    items: Meeting[],
    tone: "default" | "brand" = "default",
  ) => (
    <section key={key} aria-labelledby={`group-${key}`}>
      <h2
        id={`group-${key}`}
        className={cn(
          "mb-2 flex items-baseline gap-2 px-1 text-sm font-semibold",
          tone === "brand" ? "text-brand-700" : "text-zinc-900",
        )}
      >
        {label}
        <span className="text-xs font-normal text-zinc-400">
          {items.length}
        </span>
      </h2>
      <div
        className={cn(
          "overflow-hidden rounded-2xl border bg-surface shadow-sm divide-y divide-zinc-100",
          tone === "brand" ? "border-brand-200" : "border-zinc-200",
        )}
      >
        {items.map((meeting) => (
          <MeetingCard
            key={meeting.id}
            meeting={meeting}
            stats={statsMap[meeting.id]}
          />
        ))}
      </div>
    </section>
  );

  return (
    <div
      className="min-h-screen bg-zinc-50"
      onClickCapture={(event) => {
        // A period link includes the latest search text; do not let its pending
        // debounce overwrite that navigation with the previous period's URL.
        if ((event.target as Element).closest("a"))
          clearTimeout(searchTimer.current);
      }}
    >
      <div className="container mx-auto max-w-5xl px-4 py-12">
        <PageHeader
          title="Meetings"
          icon={CalendarIcon}
          description="Agendas, minutes, video and decisions from every council and committee meeting."
          actions={
            <div className="flex items-center gap-1 rounded-lg bg-zinc-200/60 p-1">
              {viewButton("list", LayoutList, "List")}
              {viewButton("calendar", CalendarIcon, "Calendar")}
            </div>
          }
        />

        <FilterBar
          search={
            <SearchField
              aria-label="Search meetings"
              placeholder="Search titles and summaries"
              value={searchQuery}
              onValueChange={setSearchQuery}
            />
          }
          controls={
            <>
              <NativeSelect
                aria-label="Year"
                className="w-28"
                value={selectedYear}
                onChange={(e) =>
                  updateFilters({
                    year: e.currentTarget.value,
                  })
                }
              >
                {years.map((y) => (
                  <option key={y} value={y}>
                    {y}
                  </option>
                ))}
              </NativeSelect>
              {(meetingTypes.length > 1 || typeFilter) && (
                <NativeSelect
                  aria-label="Meeting type"
                  className="min-w-0 flex-1 sm:w-52 sm:flex-none"
                  value={typeFilter}
                  onChange={(e) =>
                    updateFilters({ type: e.currentTarget.value || null })
                  }
                >
                  <option value="">All meeting types</option>
                  {meetingTypes.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </NativeSelect>
              )}
              <button
                onClick={() =>
                  updateFilters({ sort: sortOrder === "desc" ? "asc" : null })
                }
                aria-label={
                  sortOrder === "desc"
                    ? "Newest first — switch to oldest first"
                    : "Oldest first — switch to newest first"
                }
                title={sortOrder === "desc" ? "Newest first" : "Oldest first"}
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-zinc-200 bg-surface text-zinc-500 shadow-xs transition-colors hover:border-zinc-300 hover:text-zinc-800"
              >
                {sortOrder === "desc" ? (
                  <ArrowDownWideNarrow className="h-4 w-4" />
                ) : (
                  <ArrowUpNarrowWide className="h-4 w-4" />
                )}
              </button>
            </>
          }
          status={
            hasActiveFilters && (
              <>
                <span className="font-semibold text-zinc-900">
                  {resultCount}
                </span>{" "}
                {resultCount === 1 ? "result" : "results"}
                <button
                  onClick={clearFilters}
                  className="ml-2 font-semibold text-brand-700 hover:text-brand-800"
                >
                  Clear
                </button>
              </>
            )
          }
        />

        <h2 className="mb-4 text-sm font-semibold text-zinc-600">
          Meetings in {periodLabel}
        </h2>
        {view === "calendar" && !loadError ? (
          <div className="overflow-hidden rounded-2xl border border-zinc-200 bg-surface shadow-sm">
            <CalendarView
              meetings={filtered}
              year={selectedYear}
              month={period.month}
              previous={canPrevious ? `?${previous}` : undefined}
              next={canNext ? `?${next}` : undefined}
              today={`?${todayParams}`}
            />
          </div>
        ) : filtered.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-zinc-300 bg-surface px-6 py-16 text-center">
            <h3 className="text-base font-semibold text-zinc-900">
              {loadError ? "Meetings could not be loaded" : "No meetings found"}
            </h3>
            <p className="mx-auto mt-1 max-w-sm text-sm text-zinc-500">
              {loadError
                ? "Please try again shortly."
                : hasActiveFilters
                  ? `Nothing in ${selectedYear} matches those filters.`
                  : `No meetings recorded for ${selectedYear}.`}
            </p>
            {hasActiveFilters && (
              <button
                onClick={clearFilters}
                className="mt-4 text-sm font-semibold text-brand-700 hover:text-brand-800"
              >
                Clear filters
              </button>
            )}
          </div>
        ) : (
          <div className="flex flex-col gap-8">
            {upcoming.length > 0 &&
              group("upcoming", "Upcoming", upcoming, "brand")}
            {pastByMonth.map((g) => group(g.key, g.label, g.items))}
          </div>
        )}
        <nav
          aria-label="Meeting history"
          className="mt-8 flex flex-col gap-4 rounded-2xl border border-zinc-200 bg-surface p-4 sm:flex-row sm:items-center sm:justify-between"
        >
          <div>
            <p
              className="text-sm font-semibold text-zinc-900"
              aria-live="polite"
            >
              Showing {periodLabel}
            </p>
            <p className="mt-1 text-sm text-zinc-500">
              {loadError || bounds === null
                ? "History availability could not be loaded."
                : canPrevious
                  ? "Explore earlier meetings with your current filters."
                  : bounds?.earliest
                    ? `Available meeting records begin in ${meetingPeriodLabel(Number(bounds.earliest.slice(0, 4)), Number(bounds.earliest.slice(5, 7)))}.`
                    : "No meeting history is available yet."}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {canPrevious && (
              <Link to={`?${previous}`} className={historyLink}>
                Previous meetings{" "}
                <span className="font-normal">· {previousLabel}</span>
              </Link>
            )}
            {canNext && (
              <Link to={`?${next}`} className={historyLink}>
                Newer meetings{" "}
                <span className="font-normal">· {nextLabel}</span>
              </Link>
            )}
          </div>
        </nav>
        {yearsWithMeetings.length > 1 && (
          <nav aria-label="Meetings by year" className="mt-4 flex flex-wrap items-baseline gap-x-3 gap-y-2 px-1 text-sm">
            <span className="font-semibold text-zinc-600">Browse by year</span>
            {yearsWithMeetings.map((y) => (
              <Link
                key={y}
                to={meetingsYearPath(y, currentYear)}
                aria-current={y === selectedYear ? "page" : undefined}
                className={cn("tabular-nums hover:underline", y === selectedYear ? "font-semibold text-zinc-900" : "text-brand-700")}
              >
                {y}
              </Link>
            ))}
          </nav>
        )}
      </div>
    </div>
  );
}
