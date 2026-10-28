import { ChevronDown } from "lucide-react";
import { Badge } from "./ui/badge";
import { MotionOutcomeBadge } from "./motion-outcome-badge";
import { cn } from "../lib/utils";
import { displayTitle } from "../lib/display-text";
import { formatTimestamp } from "../lib/timeline-utils";
import type { AgendaItem } from "../lib/types";
import { MotionCard } from "./motion-card";
import { IntelligenceSection } from "./intelligence-section";

interface AgendaCardProps {
  item: AgendaItem;
  isExpanded: boolean;
  onToggle: () => void;
  onWatchVideo?: (startTime: number) => void;
  resolveSpeakerName: (seg: { speaker_name?: string | null }) => string;
}

function cleanOrder(order?: string) {
  return (order || "").trim().replace(/^[\s(.)]+|[\s(.)]+$/g, "");
}

const currency = new Intl.NumberFormat("en-CA", {
  style: "currency",
  currency: "CAD",
  maximumFractionDigits: 0,
});

/**
 * One agenda item as an expandable row (render inside a `divide-y` list).
 * Collapsed: order, title and a short meta line. Expanded: summary,
 * discussion, motions and on-demand discussion analysis.
 */
export function AgendaCard({
  item,
  isExpanded,
  onToggle,
  onWatchVideo,
  resolveSpeakerName,
}: AgendaCardProps) {
  const motions = item.motions || [];
  const motionCount = motions.length;
  const outcome = motionCount === 1 ? motions[0]?.result : undefined;
  const order = cleanOrder(item.item_order);
  const start = item.discussion_start_time;
  const panelId = `agenda-item-${item.id}`;

  const meta = [
    item.category && item.category !== "Procedural" ? item.category : null,
    item.financial_cost && item.financial_cost > 0 ? currency.format(item.financial_cost) : null,
    motionCount > 0 ? `${motionCount} ${motionCount === 1 ? "motion" : "motions"}` : null,
    start != null ? formatTimestamp(start) : null,
  ].filter(Boolean);

  return (
    <li className={cn(isExpanded && "bg-zinc-50/60")}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={isExpanded}
        aria-controls={panelId}
        className="flex w-full items-start gap-3 px-5 py-3.5 text-left transition-colors hover:bg-zinc-50"
      >
        <span className="w-10 shrink-0 pt-0.5 text-sm tabular-nums text-zinc-400">{order}</span>
        <span className="min-w-0 flex-1">
          <span className="block text-[15px] font-medium leading-snug text-zinc-900">
            {displayTitle(item.title)}
          </span>
          {(meta.length > 0 || item.is_consent_agenda || item.is_controversial) && (
            <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-zinc-500">
              {item.is_consent_agenda && <Badge variant="muted">Consent agenda</Badge>}
              {item.is_controversial && <Badge variant="warning">High interest</Badge>}
              {meta.length > 0 && <span className="tabular-nums">{meta.join(" · ")}</span>}
            </span>
          )}
        </span>
        {outcome && <MotionOutcomeBadge result={outcome} className="mt-0.5 shrink-0" />}
        <ChevronDown
          className={cn(
            "mt-0.5 h-5 w-5 shrink-0 text-zinc-400 transition-transform",
            isExpanded && "rotate-180",
          )}
          aria-hidden="true"
        />
      </button>

      {isExpanded && (
        <div id={panelId} className="space-y-5 px-5 pb-5 sm:pl-[4.25rem]">
          {item.plain_english_summary || item.description ? (
            <p className="text-sm leading-relaxed text-zinc-700">
              {item.plain_english_summary || item.description}
            </p>
          ) : (
            <p className="text-sm text-zinc-500">No summary is available for this item.</p>
          )}

          {item.debate_summary && (
            <div>
              <h4 className="mb-1 text-sm font-semibold text-zinc-900">Discussion</h4>
              <p className="text-sm leading-relaxed text-zinc-700">{item.debate_summary}</p>
            </div>
          )}

          {start != null && onWatchVideo && (
            <button
              type="button"
              onClick={() => onWatchVideo(start)}
              className="text-sm font-medium text-brand-700 hover:text-brand-800"
            >
              Watch from <span className="tabular-nums">{formatTimestamp(start)}</span>
            </button>
          )}

          {motionCount > 0 && (
            <div>
              <h4 className="mb-2 text-sm font-semibold text-zinc-900">
                {motionCount === 1 ? "Motion" : "Motions"}
              </h4>
              <ul className="divide-y divide-zinc-100 overflow-hidden rounded-xl border border-zinc-200 bg-surface">
                {motions.map((motion) => (
                  <MotionCard key={motion.id} motion={motion} onWatchVideo={onWatchVideo} className="px-4" />
                ))}
              </ul>
            </div>
          )}

          <IntelligenceSection
            itemId={item.id}
            initialIntelligence={(item.meta as any)?.intelligence}
            resolveSpeakerName={resolveSpeakerName}
          />
        </div>
      )}
    </li>
  );
}
