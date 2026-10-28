import { StanceSummary } from "./stance-summary";
import type { CouncillorStance } from "../../services/profiling";
import type { CouncillorHighlight } from "../../services/profiling";
import { HighlightCard } from "./highlight-card";
import { SectionHeading } from "../ui/section-heading";

interface PolicyTabProps {
  stances: CouncillorStance[];
  highlights: CouncillorHighlight[];
}

export function PolicyTab({ stances, highlights }: PolicyTabProps) {
  // Filter out "General" and "Administration" topics (procedural)
  const filteredStances = stances.filter(
    (s) => s.topic !== "Administration" && s.topic !== "General",
  );

  const hasContent = filteredStances.length > 0 || highlights.length > 0;

  if (!hasContent) {
    return (
      <div className="rounded-2xl border border-dashed border-zinc-300 bg-surface/60 p-5 text-sm text-zinc-500">
        <p className="font-medium text-zinc-700">No policy positions yet</p>
        <p className="mt-1 leading-relaxed">
          Positions are summarized from statements in meeting transcripts once enough have been
          analyzed. None have been generated for this person so far.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {highlights.length > 0 && (
        <section>
          <SectionHeading title="Notable positions" />
          <div className="divide-y divide-zinc-100 overflow-hidden rounded-2xl border border-zinc-200 bg-surface shadow-sm">
            {highlights.map((h, i) => (
              <HighlightCard key={i} highlight={h} />
            ))}
          </div>
        </section>
      )}

      {filteredStances.length > 0 && (
        <section>
          <SectionHeading
            title="Positions by topic"
            description="AI summaries of recorded statements. Treat low-evidence topics with caution."
          />
          <StanceSummary stances={filteredStances} />
        </section>
      )}
    </div>
  );
}
