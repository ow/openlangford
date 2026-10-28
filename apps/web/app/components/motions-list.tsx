import { useState, useMemo } from "react";
import type { AgendaItem, Motion } from "../lib/types";
import { normalizeMotionResult } from "../lib/motion-utils";
import { displayTitle } from "../lib/display-text";
import { FilterBar } from "./ui/filter-bar";
import { SearchField } from "./ui/search-field";
import { NativeSelect } from "./ui/native-select";
import { MotionCard } from "./motion-card";

interface MotionsListProps {
  agendaItems: AgendaItem[];
  onWatchVideo?: (seconds: number) => void;
}

type OutcomeFilter = "all" | "passed" | "failed";

function cleanOrder(order?: string) {
  return (order || "").trim().replace(/^[\s(.)]+|[\s(.)]+$/g, "");
}

/**
 * Every motion in the meeting as one searchable list, filterable by outcome.
 */
export function MotionsList({ agendaItems, onWatchVideo }: MotionsListProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const [filter, setFilter] = useState<OutcomeFilter>("all");

  const allMotions = useMemo(() => {
    const motions: (Motion & { context: string; itemTitle: string })[] = [];
    agendaItems.forEach((item) => {
      const order = cleanOrder(item.item_order);
      const title = displayTitle(item.title);
      item.motions?.forEach((motion) => {
        motions.push({
          ...motion,
          itemTitle: item.title || "",
          context: order ? `${order} · ${title}` : title,
        });
      });
    });
    return motions;
  }, [agendaItems]);

  const filteredMotions = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return allMotions.filter((m) => {
      const matchesSearch =
        !q ||
        (m.text_content || "").toLowerCase().includes(q) ||
        (m.plain_english_summary || "").toLowerCase().includes(q) ||
        m.itemTitle.toLowerCase().includes(q);
      const matchesFilter = filter === "all" || normalizeMotionResult(m.result) === filter;
      return matchesSearch && matchesFilter;
    });
  }, [allMotions, searchQuery, filter]);

  if (allMotions.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-zinc-300 bg-surface/60 p-5 text-sm text-zinc-500">
        No motions were recorded for this meeting.
      </div>
    );
  }

  const filtered = filteredMotions.length !== allMotions.length;

  return (
    <div>
      <FilterBar
        sticky={false}
        className="mb-4"
        search={
          <SearchField
            value={searchQuery}
            onValueChange={setSearchQuery}
            placeholder="Search motions or agenda items"
            aria-label="Search motions"
          />
        }
        controls={
          <NativeSelect
            value={filter}
            onChange={(e) => setFilter(e.target.value as OutcomeFilter)}
            aria-label="Filter by outcome"
            className="w-full sm:w-40"
          >
            <option value="all">All outcomes</option>
            <option value="passed">Carried</option>
            <option value="failed">Defeated</option>
          </NativeSelect>
        }
      />

      <div className="overflow-hidden rounded-2xl border border-zinc-200 bg-surface shadow-sm">
        <div className="border-b border-zinc-100 px-5 py-3 text-sm text-zinc-500">
          <span className="font-semibold tabular-nums text-zinc-900">{filteredMotions.length}</span>{" "}
          {filtered ? `of ${allMotions.length} ` : ""}
          {allMotions.length === 1 ? "motion" : "motions"}
        </div>
        {filteredMotions.length > 0 ? (
          <ul className="divide-y divide-zinc-100">
            {filteredMotions.map((motion) => (
              <MotionCard
                key={motion.id}
                motion={motion}
                context={motion.context}
                onWatchVideo={onWatchVideo}
              />
            ))}
          </ul>
        ) : (
          <p className="px-5 py-6 text-sm text-zinc-500">
            No motions match your search. Try a different word or outcome.
          </p>
        )}
      </div>
    </div>
  );
}
