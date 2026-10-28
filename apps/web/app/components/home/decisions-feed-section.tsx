import { useState } from "react";
import { meetingPath } from "../../lib/paths";
import { Link } from "react-router";
import { Scale } from "lucide-react";
import { Badge } from "../ui/badge";
import { cn, formatDate } from "../../lib/utils";
import { MotionOutcomeBadge } from "../motion-outcome-badge";
import { SectionHeading } from "../ui/section-heading";

interface Decision {
  id: number;
  summary: string;
  result: string;
  financialCost: number | null;
  meetingId: number;
  meetingSlug?: string | null;
  meetingDate: string;
  meetingTitle: string;
  yesCount: number;
  noCount: number;
  voteCoverage?: string | null;
  isDivided: boolean;
}

interface DecisionsFeedSectionProps {
  decisions: Decision[];
}

export function DecisionsFeedSection({ decisions }: DecisionsFeedSectionProps) {
  if (decisions.length === 0) return null;

  const [filter, setFilter] = useState<"recent" | "divided">("recent");

  const dividedDecisions = decisions.filter((d) => d.isDivided);
  const displayedDecisions =
    filter === "divided" ? dividedDecisions : decisions.slice(0, 10);

  return (
    <section>
      <SectionHeading
        title="Recent decisions"
        icon={Scale}
        action={
          <div className="flex gap-1 bg-zinc-100 rounded-lg p-1">
            <button
              onClick={() => setFilter("recent")}
              className={cn(
                "px-3 py-1 rounded-md text-xs font-semibold transition-colors",
                filter === "recent"
                  ? "bg-surface text-zinc-900 shadow-sm"
                  : "text-zinc-500 hover:text-zinc-700"
              )}
            >
              All
            </button>
            <button
              onClick={() => setFilter("divided")}
              className={cn(
                "px-3 py-1 rounded-md text-xs font-semibold transition-colors",
                filter === "divided"
                  ? "bg-surface text-zinc-900 shadow-sm"
                  : "text-zinc-500 hover:text-zinc-700"
              )}
            >
              Dissent
              {dividedDecisions.length > 0 && (
                <span className="ml-1.5 inline-flex items-center justify-center min-w-4 h-4 px-1 rounded-full bg-amber-100 text-amber-800 text-[10px] font-bold">
                  {dividedDecisions.length}
                </span>
              )}
            </button>
          </div>
        }
      />

      {displayedDecisions.length === 0 ? (
        <div className="bg-surface rounded-2xl border border-zinc-200 shadow-sm p-6 text-center">
          <p className="text-sm text-zinc-500">
            No recorded dissent in these recent decisions
          </p>
        </div>
      ) : (
        <div className="bg-surface rounded-2xl border border-zinc-200 shadow-sm overflow-hidden divide-y divide-zinc-100">
          {displayedDecisions.map((decision) => (
            <Link
              key={decision.id}
              to={meetingPath({ id: decision.meetingId, slug: decision.meetingSlug })}
              className={cn(
                "block p-4 hover:bg-zinc-50 transition-colors",
                decision.isDivided && "border-l-2 border-l-amber-400"
              )}
            >
              <div className="flex items-start gap-3">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium leading-snug text-zinc-800 line-clamp-2 mb-2">
                    {decision.summary}
                  </p>

                  <div className="flex flex-wrap items-center gap-2">
                    {/* Result badge */}
                    <MotionOutcomeBadge result={decision.result} className="text-[10px] border-0" />

                    {/* Vote tally — only when individual votes were recorded */}
                    {/* Complete (reconstructed) roll calls show the tally; partial
                        records usually name only the people opposed. */}
                    {decision.voteCoverage === "reconstructed_complete" &&
                    decision.yesCount + decision.noCount > 0 ? (
                      <span
                        className="inline-flex items-center gap-1.5 text-xs font-medium text-zinc-500"
                        title="Reconstructed from official minutes and attendance"
                      >
                        {decision.yesCount}–{decision.noCount}
                        <span className="flex items-center gap-0.5" aria-hidden="true">
                          {Array.from({ length: decision.yesCount }).map((_, i) => (
                            <span key={`y-${i}`} className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                          ))}
                          {Array.from({ length: decision.noCount }).map((_, i) => (
                            <span key={`n-${i}`} className="w-1.5 h-1.5 rounded-full bg-red-500" />
                          ))}
                        </span>
                      </span>
                    ) : decision.noCount > 0 ? (
                      <span className="text-xs font-medium text-zinc-500">
                        {decision.noCount} recorded opposed
                      </span>
                    ) : null}

                    {/* Divided vote badge */}
                    {decision.isDivided && (
                      <Badge variant="warning" className="text-[10px]">
                        Dissent recorded
                      </Badge>
                    )}

                    {/* Financial cost */}
                    {decision.financialCost != null &&
                      decision.financialCost > 0 && (
                        <Badge variant="muted" className="text-[10px] tabular-nums">
                          ${decision.financialCost.toLocaleString()}
                        </Badge>
                      )}
                  </div>

                  {/* Meeting context */}
                  {decision.meetingDate && (
                    <p className="text-xs text-zinc-500 mt-2">
                      {formatDate(decision.meetingDate)}
                      {decision.meetingTitle &&
                        ` · ${decision.meetingTitle}`}
                    </p>
                  )}
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </section>
  );
}
