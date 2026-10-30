import { personPath } from "../lib/people-paths";
import { useState, useMemo } from "react";
import { Link } from "react-router";
import { cn } from "../lib/utils";
import type { AgendaItem, Person } from "../lib/types";
import { SPEAKER_COLORS, getSpeakerColorIndex } from "../lib/colors";
import { FilterBar } from "./ui/filter-bar";
import { SearchField } from "./ui/search-field";
import { NativeSelect } from "./ui/native-select";
import { SpeakerName } from "./ui/speaker-name";

type Group = "council" | "staff" | "others";

interface ParticipantRecord {
  id: string | number;
  person_id: number | null;
  person?: Person;
  resolvedName: string;
  isVirtual?: boolean;
  attendance_mode?: string;
  group: Group;
}

interface PeopleGridProps {
  attendanceGroups: {
    council: any[];
    staff: any[];
    others: any[];
  };
  speakerStats: {
    stats: Record<string, number>;
    totalTime: number;
  };
  getPersonRole: (person?: any) => string | null;
  agendaItems: AgendaItem[];
}

const GROUP_LABELS: Record<Group, string> = {
  council: "Council",
  staff: "Staff",
  others: "Others",
};

function formatDuration(seconds: number) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  if (m === 0) return `${s}s`;
  return `${m}m ${s.toString().padStart(2, "0")}s`;
}

function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join("");
}

/**
 * Everyone who attended or spoke, with speaking time and motions
 * moved/seconded, plus a speaking-time distribution bar.
 */
export function PeopleGrid({
  attendanceGroups,
  speakerStats,
  getPersonRole,
  agendaItems,
}: PeopleGridProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const [activeFilter, setActiveFilter] = useState<"all" | Group>("all");

  const allParticipants = useMemo<ParticipantRecord[]>(
    () => [
      ...attendanceGroups.council.map((a) => ({ ...a, group: "council" as const })),
      ...attendanceGroups.staff.map((a) => ({ ...a, group: "staff" as const })),
      ...attendanceGroups.others.map((a) => ({ ...a, group: "others" as const })),
    ],
    [attendanceGroups],
  );

  const motionsByPerson = useMemo(() => {
    const counts: Record<number, number> = {};
    agendaItems.forEach((item) => {
      item.motions?.forEach((m) => {
        if (m.mover_id) counts[m.mover_id] = (counts[m.mover_id] || 0) + 1;
        if (m.seconder_id) counts[m.seconder_id] = (counts[m.seconder_id] || 0) + 1;
      });
    });
    return counts;
  }, [agendaItems]);

  const filteredParticipants = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return allParticipants
      .filter((p) => {
        const matchesSearch = !q || p.resolvedName.toLowerCase().includes(q);
        const matchesFilter = activeFilter === "all" || p.group === activeFilter;
        return matchesSearch && matchesFilter;
      })
      .sort(
        (a, b) =>
          (speakerStats.stats[b.resolvedName] || 0) - (speakerStats.stats[a.resolvedName] || 0),
      );
  }, [allParticipants, searchQuery, activeFilter, speakerStats]);

  const distributionData = useMemo(
    () =>
      Object.entries(speakerStats.stats)
        .filter(([, time]) => time > 0)
        .sort(([, a], [, b]) => b - a),
    [speakerStats],
  );

  if (allParticipants.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-zinc-300 bg-surface/60 p-5 text-sm text-zinc-500">
        No attendance or speaker information has been recorded for this meeting.
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {speakerStats.totalTime > 0 && distributionData.length > 0 && (
        <section className="rounded-2xl border border-zinc-200 bg-surface p-5 shadow-sm">
          <h3 className="text-sm font-semibold text-zinc-900">Who did the talking</h3>
          <p className="mb-3 text-xs text-zinc-500">
            Share of recorded speaking time · {formatDuration(speakerStats.totalTime)} total
          </p>
          <div className="flex h-3 w-full overflow-hidden rounded-full bg-zinc-100">
            {distributionData.map(([name, time]) => {
              const percent = (time / speakerStats.totalTime) * 100;
              if (percent < 1) return null;
              return (
                <div
                  key={name}
                  className={cn("h-full border-r border-surface last:border-r-0", SPEAKER_COLORS[getSpeakerColorIndex(name)])}
                  style={{ width: `${percent}%` }}
                  title={`${name}: ${formatDuration(time)} (${percent.toFixed(0)}%)`}
                />
              );
            })}
          </div>
          <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-zinc-600">
            {distributionData.slice(0, 6).map(([name, time]) => (
              <li key={name} className="flex items-center gap-1.5">
                <span className={cn("h-2 w-2 rounded-full", SPEAKER_COLORS[getSpeakerColorIndex(name)])} />
                <span className="max-w-[10rem] truncate">{name}</span>
                <span className="tabular-nums text-zinc-400">
                  {((time / speakerStats.totalTime) * 100).toFixed(0)}%
                </span>
              </li>
            ))}
            {distributionData.length > 6 && (
              <li className="text-zinc-400">+{distributionData.length - 6} more</li>
            )}
          </ul>
        </section>
      )}

      <div>
        <FilterBar
          sticky={false}
          className="mb-4"
          search={
            <SearchField
              value={searchQuery}
              onValueChange={setSearchQuery}
              placeholder="Search participants"
              aria-label="Search participants"
            />
          }
          controls={
            <NativeSelect
              value={activeFilter}
              onChange={(e) => setActiveFilter(e.target.value as "all" | Group)}
              aria-label="Filter by group"
              className="w-full sm:w-40"
            >
              <option value="all">Everyone</option>
              <option value="council">Council</option>
              <option value="staff">Staff</option>
              <option value="others">Others</option>
            </NativeSelect>
          }
        />

        <div className="overflow-hidden rounded-2xl border border-zinc-200 bg-surface shadow-sm">
          {filteredParticipants.length > 0 ? (
            <ul className="divide-y divide-zinc-100">
              {filteredParticipants.map((p) => {
                const role =
                  getPersonRole(p.person) ||
                  (!p.person_id && p.isVirtual ? "Unidentified speaker" : GROUP_LABELS[p.group]);
                const time = speakerStats.stats[p.resolvedName] || 0;
                const percent = speakerStats.totalTime > 0 ? (time / speakerStats.totalTime) * 100 : 0;
                const motionCount = p.person_id ? motionsByPerson[p.person_id] || 0 : 0;
                const away = p.attendance_mode === "Regrets" || p.attendance_mode === "Absent";

                return (
                  <li key={p.id} className="flex items-center gap-3 px-5 py-3">
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-full bg-zinc-100 text-xs font-semibold text-zinc-500">
                      {p.person?.image_url ? (
                        <img src={p.person.image_url} alt="" className="h-full w-full object-cover" />
                      ) : (
                        initials(p.resolvedName)
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      {p.person_id ? (
                        <Link
                          to={personPath({ id: p.person_id, name: p.person?.name || p.resolvedName, slug: (p.person as any)?.slug })}
                          className="block truncate text-sm font-medium text-zinc-900 hover:text-brand-700"
                        >
                          <SpeakerName name={p.resolvedName} />
                        </Link>
                      ) : (
                        <SpeakerName name={p.resolvedName} className="block truncate text-sm font-medium text-zinc-900" />
                      )}
                      <span className="block truncate text-xs text-zinc-500">
                        {role}
                        {away && <span className="text-red-700"> · {p.attendance_mode}</span>}
                      </span>
                    </div>
                    <div className="shrink-0 text-right text-xs text-zinc-500">
                      {time > 0 ? (
                        <span className="block tabular-nums">
                          <span className="font-medium text-zinc-800">{formatDuration(time)}</span>
                          <span className="text-zinc-400"> · {percent.toFixed(0)}%</span>
                        </span>
                      ) : null}
                      {motionCount > 0 && (
                        <span className="block tabular-nums">
                          {motionCount} {motionCount === 1 ? "motion" : "motions"} moved/seconded
                        </span>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="px-5 py-6 text-sm text-zinc-500">No participants match your search.</p>
          )}
        </div>
      </div>
    </div>
  );
}
