/**
 * Shaping of the meeting page's loader data before it is serialized into the HTML and hydration payload.
 * Everything dropped here is something no component on the page reads.
 */

/** agenda_items.meta keys the meeting page reads (AgendaOverview, item commitments, timeline story). */
export const PUBLIC_AGENDA_ITEM_META_KEYS = ["participation", "written_participation", "remarks", "commitments"] as const;

export function publicAgendaItemMeta(meta: Record<string, any> | null | undefined): Record<string, any> {
  const out: Record<string, any> = {};
  for (const key of PUBLIC_AGENDA_ITEM_META_KEYS) if (meta?.[key] != null) out[key] = meta[key];
  return out;
}

/** The transcript timing stub the page needs before the text arrives: id, times, and who spoke. */
export function transcriptStub(segment: Record<string, any>) {
  const { id, start_time, end_time, person_id, speaker_name } = segment;
  return { id, start_time, end_time, person_id, speaker_name };
}
