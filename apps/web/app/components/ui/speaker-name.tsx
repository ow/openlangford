import { cn } from "../../lib/utils";
import { formatSpeakerName, isUnidentifiedSpeaker, UNIDENTIFIED_SPEAKER_CLASS } from "../../lib/speaker-labels";

/** A transcript speaker's name; unidentified speakers ("Speaker 1") render quieter than named people. */
export function SpeakerName({ name, className }: { name?: string | null; className?: string }) {
  return (
    <span className={cn(className, isUnidentifiedSpeaker(name) && UNIDENTIFIED_SPEAKER_CLASS)}>
      {formatSpeakerName(name)}
    </span>
  );
}
