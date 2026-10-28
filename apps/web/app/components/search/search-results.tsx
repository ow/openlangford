import { useState, useEffect } from "react";
import { meetingPath } from "../../lib/paths";
import type { UnifiedSearchResult } from "../../services/hybrid-search.server";
import { Link } from "react-router";
import { ResultCard } from "./result-card";
import { formatDate } from "../../lib/utils";
import { Search } from "lucide-react";

const PAGE_SIZE = 10;

// ---------------------------------------------------------------------------
// SearchResults component
// ---------------------------------------------------------------------------

interface SearchResultsProps {
  results: UnifiedSearchResult[];
  query: string;
  isLoading: boolean;
  activeTypes?: Array<UnifiedSearchResult["type"]>;
}

export function SearchResults({
  results,
  query,
  isLoading,
  activeTypes,
}: SearchResultsProps) {
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

  // Reset visible count when results change (new search)
  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
  }, [results]);

  const visibleResults = results.slice(0, visibleCount);
  const hasMore = results.length > visibleCount;

  // Group hits from the same meeting under one heading, in rank order of their best hit.
  const groups: { key: string; meeting?: { id: number; slug?: string | null; title?: string | null; date?: string | null }; items: UnifiedSearchResult[] }[] = [];
  const byMeeting = new Map<number, (typeof groups)[number]>();
  for (const r of visibleResults) {
    if (r.meeting_id) {
      const existing = byMeeting.get(r.meeting_id);
      if (existing) {
        existing.items.push(r);
        continue;
      }
      const group = { key: `m${r.meeting_id}`, meeting: { id: r.meeting_id, slug: r.meeting_slug, title: r.meeting_title, date: r.meeting_date }, items: [r] };
      byMeeting.set(r.meeting_id, group);
      groups.push(group);
    } else {
      groups.push({ key: `${r.type}-${r.id}`, items: [r] });
    }
  }

  return (
    <div className="mt-4 space-y-4">
      {/* Loading skeleton */}
      {isLoading && (
        <div className="space-y-4">
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              className="p-5 bg-surface rounded-2xl border border-zinc-200 animate-pulse"
            >
              <div className="flex items-center gap-2 mb-3">
                <div className="h-4 w-4 bg-zinc-200 rounded" />
                <div className="h-4 w-20 bg-zinc-200 rounded" />
                <div className="h-4 w-24 bg-zinc-200 rounded ml-auto" />
              </div>
              <div className="space-y-2">
                <div className="h-4 bg-zinc-200 rounded w-full" />
                <div className="h-4 bg-zinc-200 rounded w-3/4" />
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Results list */}
      {!isLoading && results.length > 0 && (
        <div className="space-y-4">
          <ul className="overflow-hidden rounded-2xl border border-zinc-200 bg-surface shadow-sm divide-y divide-zinc-100">
            {groups.map((group) =>
              group.meeting && group.items.length > 1 ? (
                <li key={group.key}>
                  <Link
                    to={meetingPath(group.meeting)}
                    className="flex items-baseline justify-between gap-3 bg-zinc-50/80 px-5 py-2 text-xs text-zinc-500 hover:text-brand-700"
                  >
                    <span className="font-semibold text-zinc-700">{group.meeting.title || "Meeting"}</span>
                    <span className="shrink-0 tabular-nums">
                      {group.meeting.date ? formatDate(group.meeting.date) : ""} · {group.items.length} matches
                    </span>
                  </Link>
                  <ul className="divide-y divide-zinc-100">
                    {group.items.map((result) => (
                      <li key={`${result.type}-${result.id}`}>
                        <ResultCard result={result} query={query} position={visibleResults.indexOf(result)} />
                      </li>
                    ))}
                  </ul>
                </li>
              ) : (
                <li key={group.key}>
                  <ResultCard result={group.items[0]} query={query} position={visibleResults.indexOf(group.items[0])} />
                </li>
              ),
            )}
          </ul>

          {/* Show more button */}
          {hasMore && (
            <button
              onClick={() => setVisibleCount((c) => c + PAGE_SIZE)}
              className="mx-auto flex items-center justify-center gap-1.5 rounded-full border border-zinc-200 bg-surface px-5 py-2 text-sm font-semibold text-zinc-700 shadow-sm transition-colors hover:border-brand-300 hover:text-brand-700"
            >
              Show more ({results.length - visibleCount} remaining)
            </button>
          )}
        </div>
      )}

      {/* Empty state */}
      {!isLoading && results.length === 0 && (
        <div className="text-center py-16">
          <Search className="h-10 w-10 text-zinc-300 mx-auto mb-3" />
          <p className="text-zinc-500 text-sm">
            {activeTypes && activeTypes.length > 0
              ? `No results found for "${query}" with the selected filters. Try broadening your search.`
              : `No results found for "${query}". Try different keywords.`}
          </p>
        </div>
      )}
    </div>
  );
}
