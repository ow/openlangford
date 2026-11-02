import { CheckCircle2, MinusCircle, XCircle } from "lucide-react";
import type { Motion, Vote } from "../../lib/types";
import { displayTitle } from "../../lib/display-text";
import { isTranscribedMotion, TRANSCRIBED_NOTE, TRANSCRIBED_TITLE } from "../../lib/motion-utils";
import { MotionOutcomeBadge as OutcomeBadge } from "../motion-outcome-badge";

function formatOffset(seconds?: number | null) {
  if (!seconds || seconds <= 0) return null;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  return `${h > 0 ? `${h}:` : ""}${mm}:${String(s).padStart(2, "0")}`;
}

/** Calm, neutral motion block for matter timelines. */
export function MatterMotion({ motion }: { motion: Motion }) {
  const offset = formatOffset(motion.time_offset_seconds);
  const mover = motion.mover ? displayTitle(motion.mover) : null;
  const seconder = motion.seconder ? displayTitle(motion.seconder) : null;

  return (
    <div className="border-l-2 border-brand-200 pl-4">
      <div className="mb-1.5 flex flex-wrap items-center gap-2 text-xs text-zinc-500">
        <span className="font-medium text-zinc-700">Motion</span>
        <OutcomeBadge result={motion.result} />
        {offset && <span className="tabular-nums">at {offset}</span>}
        {isTranscribedMotion(motion) && <span title={TRANSCRIBED_TITLE}>{TRANSCRIBED_NOTE}</span>}
      </div>
      <p className="text-sm leading-relaxed text-zinc-800">
        {motion.text_content}
      </p>
      {motion.plain_english_summary && (
        <p className="mt-2 text-sm leading-relaxed text-zinc-500">
          {motion.plain_english_summary}
        </p>
      )}
      {(mover || seconder) && (
        <p className="mt-2 text-xs text-zinc-500">
          {mover && <>Moved by <span className="text-zinc-700">{mover}</span></>}
          {mover && seconder && ", "}
          {seconder && (
            <>
              {mover ? "seconded" : "Seconded"} by{" "}
              <span className="text-zinc-700">{seconder}</span>
            </>
          )}
        </p>
      )}
      {motion.votes && motion.votes.length > 0 && (
        <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-zinc-600">
          {motion.votes.map((vote: Vote) => (
            <li key={vote.id} className="flex items-center gap-1.5">
              {vote.vote === "Yes" ? (
                <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
              ) : vote.vote === "No" ? (
                <XCircle className="h-3.5 w-3.5 text-red-600" />
              ) : (
                <MinusCircle className="h-3.5 w-3.5 text-zinc-400" />
              )}
              {vote.person?.name}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
