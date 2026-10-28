import { isInferredChoice, voteTally } from "../../lib/vote-coverage";
import { useMemo, useState } from "react";
import { CheckCircle2, ChevronDown, MinusCircle, PlayCircle, XCircle } from "lucide-react";
import type { AgendaItem, Motion } from "../../lib/types";
import { normalizeMotionResult } from "../../lib/motion-utils";
import { formatTimestamp } from "../../lib/timeline-utils";
import { displayTitle, lastName } from "../../lib/display-text";
import { cn } from "../../lib/utils";

interface Decision {
  motion: Motion;
  item: AgendaItem;
  procedural: boolean;
}

interface MeetingDecisionsProps {
  agendaItems: AgendaItem[];
  onWatch?: (seconds: number) => void;
}

const ADJOURN_RE = /^\s*(that\s+)?(the\s+)?(council|meeting|committee)?\s*(be\s+)?adjourn/i;

function cleanOrder(order?: string) {
  return (order || "").trim().replace(/^[\s(.)]+|[\s(.)]+$/g, "");
}

function OutcomeIcon({ result }: { result?: string }) {
  const outcome = normalizeMotionResult(result);
  if (outcome === "passed")
    return <CheckCircle2 className="h-5 w-5 shrink-0 text-emerald-600" aria-label="Carried" />;
  if (outcome === "failed")
    return <XCircle className="h-5 w-5 shrink-0 text-red-600" aria-label="Defeated" />;
  return <MinusCircle className="h-5 w-5 shrink-0 text-zinc-400" aria-label={result || "No result"} />;
}

function DecisionRow({ decision, onWatch }: { decision: Decision; onWatch?: (s: number) => void }) {
  const { motion, item } = decision;
  const outcome = normalizeMotionResult(motion.result);
  const votes = motion.votes || [];
  const opposed = votes
    .filter((v) => v.vote === "No")
    .map((v) => lastName(v.person?.name) + (isInferredChoice(motion, v.person_id) ? " (inferred)" : ""));
  const tally = voteTally(motion);
  const abstained = votes.filter((v) => v.vote !== "Yes" && v.vote !== "No").map((v) => lastName(v.person?.name));
  const mover = motion.mover_person?.name || motion.mover;
  const seconder = motion.seconder_person?.name || motion.seconder;
  const watchTime = motion.time_offset_seconds ?? item.discussion_start_time;
  const order = cleanOrder(item.item_order);
  const [expanded, setExpanded] = useState(false);
  const text = motion.plain_english_summary || motion.text_content || "";

  return (
    <li className="flex gap-3 px-5 py-4">
      <div className="pt-0.5">
        <OutcomeIcon result={motion.result} />
      </div>
      <div className="min-w-0 flex-1">
        <p
          className={cn(
            "text-[15px] font-medium leading-snug text-zinc-900",
            !expanded && "line-clamp-3",
          )}
        >
          {text}
        </p>
        {text.length > 280 && (
          <button
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
            className="mt-1 text-xs font-medium text-brand-700 hover:text-brand-800"
          >
            {expanded ? "Show less" : "Show full motion"}
          </button>
        )}
        <p className="mt-1 text-xs text-zinc-500">
          {order && <span className="tabular-nums">{order} · </span>}
          {displayTitle(item.title)}
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-zinc-500">
          {outcome === "failed" && <span className="font-semibold text-red-700">Defeated</span>}
          {outcome !== "passed" && outcome !== "failed" && motion.result && (
            <span className="font-semibold text-zinc-600">{displayTitle(motion.result)}</span>
          )}
          {tally && (
            <span className="tabular-nums" title="Reconstructed from official minutes and attendance">
              Vote {tally}
            </span>
          )}
          {opposed.length > 0 && (
            <span className="font-medium text-amber-800">
              Opposed: {opposed.join(", ")}
              {!tally && <span className="font-normal text-zinc-500"> (as recorded)</span>}
            </span>
          )}
          {abstained.length > 0 && <span>Abstained: {abstained.join(", ")}</span>}
          {mover && (
            <span>
              Moved by {lastName(mover)}
              {seconder && `, seconded by ${lastName(seconder)}`}
            </span>
          )}
          {watchTime != null && onWatch && (
            <button
              onClick={() => onWatch(watchTime)}
              className="inline-flex items-center gap-1 font-medium text-brand-700 hover:text-brand-800"
            >
              Watch <span className="tabular-nums">{formatTimestamp(watchTime)}</span>
            </button>
          )}
        </div>
      </div>
    </li>
  );
}

/**
 * Every motion from the meeting, substantive first. Procedural motions
 * (call to order, adopt agenda, adjourn…) are folded away by default.
 */
export function MeetingDecisions({ agendaItems, onWatch }: MeetingDecisionsProps) {
  const [showProcedural, setShowProcedural] = useState(false);

  const { substantive, procedural } = useMemo(() => {
    const all: Decision[] = agendaItems
      .flatMap((item) =>
        (item.motions || []).map((motion) => ({
          motion,
          item,
          procedural:
            motion.disposition === "Procedural" ||
            item.category === "Procedural" ||
            !motion.result ||
            ADJOURN_RE.test(motion.text_content || ""),
        })),
      )
      .map((d, i) => ({ d, i, t: d.motion.time_offset_seconds ?? d.item.discussion_start_time ?? null }))
      // Chronological: by meeting time when known, otherwise agenda order.
      .sort((a, b) => (a.t != null && b.t != null && a.t !== b.t ? a.t - b.t : a.i - b.i))
      .map(({ d }) => d);
    return {
      substantive: all.filter((d) => !d.procedural),
      procedural: all.filter((d) => d.procedural),
    };
  }, [agendaItems]);

  if (substantive.length + procedural.length === 0) return null;

  const defeated = substantive.filter((d) => normalizeMotionResult(d.motion.result) === "failed").length;
  const divided = substantive.filter((d) => (d.motion.votes || []).some((v) => v.vote === "No")).length;

  return (
    <div className="overflow-hidden rounded-2xl border border-zinc-200 bg-surface shadow-sm">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-zinc-100 px-5 py-3 text-sm text-zinc-500">
        <span>
          <span className="font-semibold text-zinc-900">{substantive.length}</span>{" "}
          {substantive.length === 1 ? "decision" : "decisions"}
        </span>
        {defeated > 0 && <span className="text-red-700">{defeated} defeated</span>}
        {divided > 0 && <span className="text-amber-800">{divided} with opposition</span>}
      </div>
      {substantive.length > 0 ? (
        <ul className="divide-y divide-zinc-100">
          {substantive.map((d) => (
            <DecisionRow key={d.motion.id} decision={d} onWatch={onWatch} />
          ))}
        </ul>
      ) : (
        <p className="px-5 py-4 text-sm text-zinc-500">Only procedural motions were recorded.</p>
      )}
      {procedural.length > 0 && (
        <div className="border-t border-zinc-100">
          <button
            onClick={() => setShowProcedural((v) => !v)}
            aria-expanded={showProcedural}
            className="flex w-full items-center justify-between px-5 py-3 text-sm font-medium text-zinc-600 hover:bg-zinc-50"
          >
            {showProcedural ? "Hide" : "Show"} {procedural.length} procedural{" "}
            {procedural.length === 1 ? "motion" : "motions"}
            <ChevronDown className={cn("h-4 w-4 transition-transform", showProcedural && "rotate-180")} />
          </button>
          {showProcedural && (
            <ul className="divide-y divide-zinc-100 border-t border-zinc-100 bg-zinc-50/50">
              {procedural.map((d) => (
                <DecisionRow key={d.motion.id} decision={d} onWatch={onWatch} />
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
