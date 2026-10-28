import { useState } from "react";
import { meetingPath } from "../../lib/paths";
import { Link } from "react-router";
import { ChevronDown } from "lucide-react";
import { Badge } from "../ui/badge";
import { cn, formatDate } from "../../lib/utils";
import { StanceSpectrum } from "./stance-spectrum";
import type { CouncillorStance } from "../../services/profiling";

// ── Types ──

interface StanceSummaryProps {
  stances: CouncillorStance[];
}

// ── Evidence ──

function EvidenceSection({
  quotes,
  motionIds,
}: {
  quotes: CouncillorStance["evidence_quotes"];
  motionIds: CouncillorStance["evidence_motion_ids"];
}) {
  const [expanded, setExpanded] = useState(false);

  const hasQuotes = quotes && quotes.length > 0;
  const hasMotions = motionIds && motionIds.length > 0;

  if (!hasQuotes && !hasMotions) return null;

  const parts = [
    hasQuotes ? `${quotes!.length} quote${quotes!.length !== 1 ? "s" : ""}` : null,
    hasMotions ? `${motionIds!.length} related motion${motionIds!.length !== 1 ? "s" : ""}` : null,
  ].filter(Boolean);

  return (
    <div>
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
        className="inline-flex items-center gap-1 text-sm font-medium text-zinc-600 hover:text-zinc-900"
      >
        {expanded ? "Hide" : "Show"} evidence ({parts.join(", ")})
        <ChevronDown className={cn("h-4 w-4 transition-transform", expanded && "rotate-180")} aria-hidden="true" />
      </button>

      {expanded && (
        <div className="mt-3 space-y-3">
          {hasQuotes && (
            <ul className="space-y-2">
              {quotes!.map((q, i) => (
                <li key={i} className="border-l-2 border-zinc-200 pl-3 text-sm">
                  <p className="leading-relaxed text-zinc-600">&ldquo;{q.text}&rdquo;</p>
                  <Link
                    to={meetingPath({ id: q.meeting_id, slug: q.meeting_slug })}
                    className="mt-0.5 inline-block text-xs font-medium text-brand-700 hover:underline"
                  >
                    {formatDate(q.date)}
                  </Link>
                </li>
              ))}
            </ul>
          )}

          {hasMotions && (
            <p className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
              {motionIds!.map((mId) => (
                <Link
                  key={mId}
                  to={`/motions/${mId}`}
                  className="font-medium text-brand-700 hover:underline"
                >
                  Motion #{mId}
                </Link>
              ))}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

// ── Stance row ──

function StanceCard({ stance }: { stance: CouncillorStance }) {
  const isLowData = stance.statement_count < 3;

  return (
    <div className="space-y-3 p-4 sm:p-5">
      <div className="flex items-center justify-between gap-3">
        <h4 className="text-sm font-semibold text-zinc-900">{stance.topic}</h4>
        <Badge variant={isLowData ? "warning" : "muted"} className="tabular-nums">
          {stance.statement_count} statement{stance.statement_count !== 1 ? "s" : ""}
        </Badge>
      </div>

      <StanceSpectrum score={stance.position_score ?? 0} position={stance.position} />

      <p className="text-sm leading-relaxed text-zinc-700">{stance.summary}</p>
      {isLowData && (
        <p className="text-xs text-zinc-500">
          Limited evidence — this may change as more meetings are analyzed.
        </p>
      )}

      <EvidenceSection quotes={stance.evidence_quotes} motionIds={stance.evidence_motion_ids} />
    </div>
  );
}

// ── Main Component ──

export function StanceSummary({ stances }: StanceSummaryProps) {
  if (!stances || stances.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-zinc-300 bg-surface/60 p-5 text-sm text-zinc-500">
        No topic positions have been summarized yet.
      </div>
    );
  }

  return (
    <div className="divide-y divide-zinc-100 overflow-hidden rounded-2xl border border-zinc-200 bg-surface shadow-sm">
      {stances.map((stance) => (
        <StanceCard key={stance.id} stance={stance} />
      ))}
    </div>
  );
}
