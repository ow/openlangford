import { VideoDissentNote } from "./video-dissent-note";
import { TermText } from "./term";
import { isInferredChoice, voteTally } from "../lib/vote-coverage";
import { CheckCircle2, MinusCircle, XCircle } from "lucide-react";
import type { Motion } from "../lib/types";
import { isTranscribedMotion, normalizeMotionResult, TRANSCRIBED_NOTE, TRANSCRIBED_TITLE } from "../lib/motion-utils";
import { formatTimestamp } from "../lib/timeline-utils";
import { displayTitle, lastName } from "../lib/display-text";
import { cn } from "../lib/utils";

interface MotionCardProps {
  motion: Motion;
  /** Optional context line (e.g. "8.1 · Rezoning application"). */
  context?: string;
  onWatchVideo?: (seconds: number) => void;
  className?: string;
}

function OutcomeIcon({ result }: { result?: string }) {
  const outcome = normalizeMotionResult(result);
  if (outcome === "passed")
    return <CheckCircle2 className="h-5 w-5 shrink-0 text-emerald-600" aria-label="Carried" />;
  if (outcome === "failed")
    return <XCircle className="h-5 w-5 shrink-0 text-red-600" aria-label="Defeated" />;
  return <MinusCircle className="h-5 w-5 shrink-0 text-zinc-400" aria-label={result || "No result"} />;
}

/**
 * One motion as a compact list row (render inside a `divide-y` list).
 * Mirrors the decision rows on the meeting page.
 */
export function MotionCard({ motion, context, onWatchVideo, className }: MotionCardProps) {
  const outcome = normalizeMotionResult(motion.result);
  const votes = motion.votes || [];
  const opposed = votes
    .filter((v) => v.vote === "No")
    .map((v) => lastName(v.person?.name) + (isInferredChoice(motion, v.person_id) ? " (inferred)" : ""));
  const tally = voteTally(motion);
  const abstained = votes
    .filter((v) => v.vote !== "Yes" && v.vote !== "No")
    .map((v) => lastName(v.person?.name));
  const mover = motion.mover_person?.name || motion.mover;
  const seconder = motion.seconder_person?.name || motion.seconder;
  const watchTime = motion.time_offset_seconds;
  const hasSummary = Boolean(motion.plain_english_summary);

  return (
    <li className={cn("flex gap-3 px-5 py-4", className)}>
      <div className="pt-0.5">
        <OutcomeIcon result={motion.result} />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-[15px] font-medium leading-snug text-zinc-900">
          <TermText text={motion.plain_english_summary || motion.text_content} />
        </p>
        {hasSummary && motion.text_content && (
          <p className="mt-1.5 border-l-2 border-zinc-200 pl-3 text-sm leading-relaxed text-zinc-600">
            <TermText text={motion.text_content} />
          </p>
        )}
        {context && <p className="mt-1.5 text-xs text-zinc-500">{context}</p>}
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
          {isTranscribedMotion(motion) && <span title={TRANSCRIBED_TITLE}>{TRANSCRIBED_NOTE}</span>}
          {watchTime != null && onWatchVideo && (
            <button
              type="button"
              onClick={() => onWatchVideo(watchTime)}
              className="font-medium text-brand-700 hover:text-brand-800"
            >
              Watch <span className="tabular-nums">{formatTimestamp(watchTime)}</span>
            </button>
          )}
        </div>
        <VideoDissentNote motion={motion} className="mt-1.5" />
      </div>
    </li>
  );
}
