/**
 * Public display of transcript speaker names. The pipeline stores raw
 * diarization labels ("Speaker_1", "SPEAKER_07") until a person is matched;
 * residents see "Speaker 1", styled quieter than a named person. Stored data
 * is never rewritten here: this is presentation only.
 */

const DIARIZATION_LABEL = /^(?:speaker|spk)[\s_-]*0*(\d+)$/i;
const UNKNOWN_LABEL = /^(?:unknown|unidentified)(?:[\s_-]+speaker)?$/i;

export const UNKNOWN_SPEAKER = "Unknown speaker";

/** Tailwind classes that set an unidentified speaker apart from a named one. */
export const UNIDENTIFIED_SPEAKER_CLASS = "font-normal italic text-zinc-500";

/** True for a diarization label or an unknown speaker, false for a real name. */
export function isUnidentifiedSpeaker(name?: string | null): boolean {
  const raw = (name ?? "").trim();
  return !raw || DIARIZATION_LABEL.test(raw) || UNKNOWN_LABEL.test(raw);
}

/** "Speaker_01" → "Speaker 1"; empty/"Unknown" → "Unknown speaker"; names unchanged. */
export function formatSpeakerName(name?: string | null): string {
  const raw = (name ?? "").trim();
  if (!raw || UNKNOWN_LABEL.test(raw)) return UNKNOWN_SPEAKER;
  const label = DIARIZATION_LABEL.exec(raw);
  return label ? `Speaker ${Number(label[1])}` : raw;
}
