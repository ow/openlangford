import { useState } from "react";
import { meetingPath } from "../../lib/paths";
import { Link } from "react-router";
import { SearchField } from "../ui/search-field";
import { NativeSelect } from "../ui/native-select";
import { formatDate } from "../../lib/utils";

export interface ParticipationHistory {
  name: string;
  coverageNote: string;
  records: {
    meetingId: number;
    meetingSlug?: string | null;
    date: string;
    meetingType: string;
    minutesUrl: string;
    recordingUrl: string;
    summary: string;
  }[];
}

export function PublicParticipation({ history, beforeCouncil = true }: { history: ParticipationHistory; beforeCouncil?: boolean }) {
  const [query, setQuery] = useState("");
  const [year, setYear] = useState("all");
  const [expanded, setExpanded] = useState(false);
  const years = [...new Set(history.records.map((record) => record.date.slice(0, 4)))].sort().reverse();
  const matching = history.records.filter((record) =>
    (year === "all" || record.date.startsWith(year)) &&
    `${record.summary} ${record.date} ${record.meetingType}`.toLowerCase().includes(query.trim().toLowerCase()),
  ).sort((a, b) => b.date.localeCompare(a.date));
  const visible = expanded ? matching : matching.slice(0, 6);

  return (
    <section id="public-participation" className="overflow-hidden rounded-2xl border border-zinc-200 bg-surface shadow-sm">
      <div className="space-y-4 p-5 sm:p-6">
        <div>
          {beforeCouncil && <p className="text-sm text-zinc-500">Before council service</p>}
          <h2 className="mt-0.5 text-lg font-bold tracking-tight text-zinc-900">Public participation</h2>
          <p className="mt-2 text-sm leading-relaxed text-zinc-600">
            {history.name}’s {beforeCouncil ? "earlier " : ""}appearances as a member of the public.
            These summaries describe statements recorded in official minutes; they are not verbatim quotations or council votes.
          </p>
          <p className="mt-2 text-xs text-zinc-500">{history.coverageNote} These records establish appearances; exact speaking times are not established.</p>
        </div>
        <div className="flex flex-col gap-3 sm:flex-row">
          <SearchField
            value={query}
            onValueChange={(value) => { setQuery(value); setExpanded(false); }}
            placeholder="Search statements — taxes, trees, RCMP…"
            aria-label="Search statements"
            className="flex-1"
          />
          <NativeSelect
            value={year}
            onChange={(event) => { setYear(event.target.value); setExpanded(false); }}
            aria-label="Year"
            className="sm:w-40"
          >
            <option value="all">All years</option>
            {years.map((value) => <option key={value} value={value}>{value}</option>)}
          </NativeSelect>
        </div>
        <p className="text-xs text-zinc-500 tabular-nums" aria-live="polite">{matching.length} of {history.records.length} meetings{matching.length > visible.length ? ` · showing ${visible.length}` : ""}</p>
      </div>
      {matching.length > 0 ? (
        <ol className="divide-y divide-zinc-100 border-t border-zinc-100">
          {visible.map((record) => (
            <li key={record.meetingId} className="space-y-1.5 px-5 py-4 sm:px-6">
              <Link to={meetingPath({ id: record.meetingId, slug: record.meetingSlug })} className="text-sm font-semibold text-zinc-900 hover:text-brand-700 hover:underline">{formatDate(record.date)} · {record.meetingType}</Link>
              <p className="text-sm leading-relaxed text-zinc-700">{record.summary}</p>
              <p className="flex flex-wrap gap-x-4 gap-y-1 text-xs font-medium">
                <a href={record.minutesUrl} target="_blank" rel="noreferrer" className="text-brand-700 hover:underline">Official minutes</a>
                <a href={record.recordingUrl} target="_blank" rel="noreferrer" className="text-brand-700 hover:underline">Official recording</a>
              </p>
            </li>
          ))}
        </ol>
      ) : (
        <p className="border-t border-zinc-100 px-5 py-4 text-sm text-zinc-500 sm:px-6">No statements match these filters.</p>
      )}
      {matching.length > 6 && (
        <div className="border-t border-zinc-100 px-5 py-3 sm:px-6">
          <button type="button" onClick={() => setExpanded(!expanded)} className="text-sm font-semibold text-brand-700 hover:text-brand-800">
            {expanded ? "Show fewer meetings" : `Show all ${matching.length} meetings`}
          </button>
        </div>
      )}
    </section>
  );
}
