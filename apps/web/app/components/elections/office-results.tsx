import { Link } from "react-router";
import { Badge } from "../ui/badge";
import { SectionHeading } from "../ui/section-heading";
import { personPath } from "../../lib/people-paths";
import { cn } from "../../lib/utils";

function initials(name?: string | null) {
  if (!name) return "?";
  return name
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

function Avatar({ person }: { person: any }) {
  return (
    <div className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-full bg-zinc-100 text-xs font-semibold text-zinc-500 ring-1 ring-zinc-200">
      {person?.image_url ? (
        <img
          src={person.image_url}
          alt=""
          className="h-full w-full object-cover"
          loading="lazy"
        />
      ) : (
        initials(person?.name)
      )}
    </div>
  );
}

interface OfficeResultsProps {
  office: any;
  preliminary: boolean;
}

export function OfficeResults({ office, preliminary }: OfficeResultsProps) {
  const candidates = [...(office.candidacies || [])].sort(
    (a: any, b: any) => (b.votes_received || 0) - (a.votes_received || 0),
  );
  const totalVotes = candidates.reduce(
    (acc: number, c: any) => acc + (c.votes_received || 0),
    0,
  );
  const maxVotes = candidates[0]?.votes_received || 0;
  const seats: number = office.seats_available || 0;
  const showCutoff = seats > 0 && candidates.length > seats;

  const meta = [
    `${seats} ${seats === 1 ? "seat" : "seats"}`,
    `${candidates.length} ${candidates.length === 1 ? "candidate" : "candidates"}`,
    totalVotes > 0 ? `${totalVotes.toLocaleString()} candidate votes` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <section>
      <SectionHeading title={office.office} description={meta} />

      {candidates.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-zinc-200 bg-surface p-6 text-center text-sm text-zinc-500">
          No candidates recorded for this office.
        </div>
      ) : (
        <div className="overflow-hidden rounded-2xl border border-zinc-200 bg-surface shadow-sm">
          <div className="hidden grid-cols-[1.5rem_minmax(0,1fr)_5.5rem_11rem] items-center gap-4 border-b border-zinc-100 bg-zinc-50/60 px-5 py-2 text-xs font-medium text-zinc-500 sm:grid">
            <span className="text-right">#</span>
            <span>Candidate</span>
            <span className="text-right">Votes</span>
            <span>Share</span>
          </div>
          <ol className="divide-y divide-zinc-100">
            {candidates.map((c: any, index: number) => {
              const person = c.people;
              const name = person?.name || "Unknown candidate";
              const share =
                totalVotes > 0 ? ((c.votes_received || 0) / totalVotes) * 100 : null;
              const barWidth =
                maxVotes > 0 ? ((c.votes_received || 0) / maxVotes) * 100 : 0;
              const isCutoff = showCutoff && index === seats - 1;

              return (
                <li
                  key={c.id}
                  className={cn(
                    "grid grid-cols-[1.5rem_minmax(0,1fr)_auto] items-center gap-3 px-4 py-3 sm:grid-cols-[1.5rem_minmax(0,1fr)_5.5rem_11rem] sm:gap-4 sm:px-5",
                    isCutoff && "!border-b-2 !border-b-emerald-500",
                    c.is_elected && "bg-emerald-50/30",
                  )}
                >
                  <span className="text-right text-sm font-semibold tabular-nums text-zinc-400">
                    {index + 1}
                  </span>

                  <div className="flex min-w-0 items-center gap-3">
                    <Avatar person={person} />
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        {c.person_id ? (
                          <Link
                            to={personPath({ id: c.person_id, name: person?.name, slug: person?.slug })}
                            className="truncate font-semibold text-zinc-900 hover:text-brand-700"
                          >
                            {name}
                          </Link>
                        ) : (
                          <span className="truncate font-semibold text-zinc-900">
                            {name}
                          </span>
                        )}
                        {c.is_elected && (
                          <Badge variant="success">Elected</Badge>
                        )}
                        {c.is_acclaimed && (
                          <Badge variant="brand">Acclaimed</Badge>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="text-right sm:contents">
                    <span className="block text-sm font-semibold tabular-nums text-zinc-900 sm:text-right">
                      {c.votes_received != null
                        ? c.votes_received.toLocaleString()
                        : "—"}
                    </span>
                    {share != null ? (
                      <div className="flex items-center gap-3">
                        <div className="hidden h-1.5 flex-1 overflow-hidden rounded-full bg-zinc-100 sm:block">
                          <div
                            className={cn(
                              "h-full rounded-full",
                              c.is_elected ? "bg-brand-600" : "bg-zinc-300",
                            )}
                            style={{ width: `${barWidth}%` }}
                          />
                        </div>
                        <span className="w-full text-xs tabular-nums text-zinc-500 sm:w-12 sm:text-right sm:text-sm">
                          {share.toFixed(1)}%
                        </span>
                      </div>
                    ) : (
                      <span className="hidden sm:block" />
                    )}
                  </div>
                </li>
              );
            })}
          </ol>
          {showCutoff && (
            <p className="flex items-start gap-2 border-t border-zinc-100 px-4 py-2.5 text-xs text-zinc-500 sm:px-5">
              <span className="mt-1.5 h-0.5 w-4 shrink-0 rounded-full bg-emerald-500" aria-hidden="true" />
              <span>
              {seats === 1 ? "The leading candidate is" : `The top ${seats} candidates are`}{" "}
              {preliminary ? "elected, pending official results" : "elected"}.
              Share is of all votes cast for this office; bars are scaled to the
              leading candidate.
              </span>
            </p>
          )}
        </div>
      )}
    </section>
  );
}
