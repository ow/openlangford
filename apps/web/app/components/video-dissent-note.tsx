import { lastName } from "../lib/display-text";
import { videoDissent } from "../lib/vote-coverage";
import { cn } from "../lib/utils";

/**
 * The video and the minutes disagree about a vote: the minutes record no one opposed (so the procedure bylaw counts
 * everyone present in favour, which is the official count shown), but the video has a vote against.
 */
export function VideoDissentNote({ motion, className }: { motion: { meta?: any }; className?: string }) {
  const dissents = videoDissent(motion);
  if (!dissents.length) return null;
  return (
    <p className={cn("text-xs leading-relaxed text-amber-800", className)}>
      {dissents.map((d) => {
        // Named only when the transcript itself names them: a model-written summary's guess isn't shown as fact.
        const name = lastName(d.name);
        return (
          <span key={d.person_id ?? d.name} className="block">
            The video and the minutes disagree:{" "}
            {d.named_in_video
              ? `in the video, ${name} votes against. `
              : <>in the video, someone votes against{d.quote ? <> (“{d.quote}”)</> : null}. </>}
            The minutes record no one opposed, so the official count has everyone in favour.
          </span>
        );
      })}
    </p>
  );
}
