/**
 * How complete a motion's individual vote record is. Minutes often name only
 * the people opposed; the pipeline can reconstruct a full roll call from
 * attendance and the rule that dissent must be recorded (meta written by
 * pipeline/ingestion/ballot_reconstruction.py).
 */
type MotionLike = {
  meta?: any;
  votes?: { person_id?: number | null; vote?: string | null }[] | null;
};

export function isReconstructedVote(motion: MotionLike): boolean {
  return motion.meta?.individual_vote_coverage === "reconstructed_complete";
}

/** True when this person's choice was inferred rather than named in the source. */
export function isInferredChoice(motion: MotionLike, personId?: number | null): boolean {
  if (personId == null) return false;
  const ballot = motion.meta?.ballot_reconstruction;
  return Boolean(
    ballot?.choice_provenance?.[`person_${personId}`]?.startsWith("inferred_") ||
      ballot?.votes?.some(
        (choice: any) => choice.person_id === personId && choice.evidence?.startsWith("inferred_"),
      ),
  );
}

/** Counts are known only when the complete ballot has distinct, identified voters. */
export function completeVoteCounts(motion: MotionLike): { yes: number; no: number } | null {
  if (!isReconstructedVote(motion) || !motion.votes?.length) return null;
  const people = new Set<number>();
  let yes = 0;
  let no = 0;
  for (const choice of motion.votes) {
    if (!Number.isSafeInteger(choice.person_id) || choice.person_id! <= 0 ||
        people.has(choice.person_id!) || !["Yes", "No"].includes(choice.vote || "")) return null;
    people.add(choice.person_id!);
    if (choice.vote === "Yes") yes++;
    if (choice.vote === "No") no++;
  }
  return { yes, no };
}

/** Short tally label: "5–2" for complete records, null when only partial names exist. */
export function voteTally(motion: MotionLike): string | null {
  const counts = completeVoteCounts(motion);
  return counts && counts.yes + counts.no > 0 ? `${counts.yes}–${counts.no}` : null;
}

/** Someone the video shows voting against a motion the minutes record without dissent (pipeline video_dissent.py). */
export type VideoDissent = { person_id?: number | null; name: string; named_in_video?: boolean; quote?: string };

export function videoDissent(motion: MotionLike): VideoDissent[] {
  const list = motion.meta?.video_dissent;
  return Array.isArray(list) ? list.filter((d: any) => d && typeof d.name === "string") : [];
}
