/**
 * Admin decisions on public speaker names. Summaries tag each named (or
 * held) speaker with `name_ref`, so a decision rewrites exactly those
 * entries and keeps any "(Street)" suffix.
 */

export type ParticipationSpeaker = { who: string; name_ref?: string; [key: string]: unknown };
export type Participation = { speakers?: ParticipationSpeaker[]; [key: string]: unknown };

export function applyNameDecision(participation: Participation | null | undefined, key: string, shown: string | null) {
  if (!participation?.speakers) return { participation, changed: false };
  let changed = false;
  const speakers = participation.speakers.map((speaker) => {
    if (speaker.name_ref !== key) return speaker;
    const suffix = speaker.who.match(/\s*\([^()]*\)\s*$/)?.[0] ?? "";
    const who = (shown?.trim() || "A resident") + suffix;
    if (who === speaker.who) return speaker;
    changed = true;
    // A renamed speaker's profile link no longer holds; the pipeline re-derives it.
    const { person_id: _stale, ...rest } = speaker;
    return { ...rest, who };
  });
  return { participation: changed ? { ...participation, speakers } : participation, changed };
}

/** "M. Watmor" from the minutes plus "Marie" from the recording reads as "Marie Watmor". */
export function suggestedSpellings(transcribed: string, near: { name: string }[]) {
  const first = transcribed.split(/\s+/)[0];
  const options = [transcribed];
  for (const { name } of near) {
    const words = name.split(/\s+/);
    const merged = /^(?:[A-Z]\.\s*)+$/.test(words[0]) && first ? [first, ...words.slice(1)].join(" ") : name;
    options.push(merged);
  }
  return [...new Set(options.map((o) => o.trim()).filter(Boolean))];
}
