/**
 * What a public participant said or wrote to council, from the per-item
 * summaries in `agenda_items.meta.participation.speakers`. Only the pipeline's
 * `person_id` ties an entry to a person (never the `who` string), and the
 * `who` string is never copied out: it can carry a "(Street)" qualifier, and a
 * profile has no need to repeat where someone lives.
 */

export type ParticipantStatement = {
  agendaItemId: number;
  agendaTitle: string | null;
  meetingId: number;
  meetingSlug: string | null;
  meetingTitle: string;
  meetingDate: string;
  matter: { id: number; slug: string | null; title: string } | null;
  position: string;
  topic: string;
  point: string;
  /** Where the summary came from, when the pipeline recorded it. */
  source: "minutes" | "transcript" | null;
};

/** Row shape selected by the loader query (see participant-statements.server.ts). */
export type StatementItemRow = {
  id: number;
  title: string | null;
  speakers: unknown;
  source?: unknown;
  meetings: { id: number; slug?: string | null; title?: string | null; meeting_date?: string | null } | null;
  matter?: { id: number; slug?: string | null; title?: string | null } | null;
};

const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");

export function statementsFromItems(rows: readonly StatementItemRow[], personId: number, today: string): ParticipantStatement[] {
  const statements: ParticipantStatement[] = [];
  for (const row of rows) {
    const meeting = row.meetings;
    const date = meeting?.meeting_date?.slice(0, 10);
    if (!meeting || !date || date > today || !Array.isArray(row.speakers)) continue;
    const source = row.source === "minutes" || row.source === "transcript" ? row.source : null;
    for (const speaker of row.speakers as Record<string, unknown>[]) {
      if (!speaker || Number(speaker.person_id) !== personId) continue;
      const point = text(speaker.point);
      const topic = text(speaker.topic);
      if (!point && !topic) continue;
      statements.push({
        agendaItemId: row.id,
        agendaTitle: text(row.title) || null,
        meetingId: meeting.id,
        meetingSlug: meeting.slug || null,
        meetingTitle: text(meeting.title) || "Council meeting",
        meetingDate: date,
        matter: row.matter?.id ? { id: row.matter.id, slug: row.matter.slug || null, title: text(row.matter.title) || "Related matter" } : null,
        position: text(speaker.position).toLowerCase(),
        topic,
        point,
        source,
      });
    }
  }
  return statements.sort((a, b) => b.meetingDate.localeCompare(a.meetingDate) || a.agendaItemId - b.agendaItemId);
}

type Appearance = {
  meetingId: number;
  meetingDate: string;
  agendaItemId: number | null;
  seconds: number;
  segmentCount: number;
  firstStartTime: number;
};

/** Generic agenda headings ("Public Participation") add nothing next to the speaker's topic. */
export function isGenericParticipationHeading(title: string | null | undefined) {
  return !title || /^\s*(?:\d+[.)]?\s*)?(?:public\s+(?:participation|input|comments?|question\s+period)|question\s+period|delegations?)\s*$/i.test(title);
}

export type StatementWithAudio = ParticipantStatement & { audio: { seconds: number; firstStartTime: number } | null };

/**
 * One view of a participant: summarized statements, with any audio attributed
 * to the same agenda item folded in, plus the audio appearances no statement
 * covers. Meetings and agenda items are counted once across both sources.
 */
export function mergeParticipation<A extends Appearance>(appearances: readonly A[], statements: readonly ParticipantStatement[]) {
  const statementItems = new Set(statements.map((s) => s.agendaItemId));
  const statementsByMeeting = new Map<number, number>();
  for (const s of statements) statementsByMeeting.set(s.meetingId, (statementsByMeeting.get(s.meetingId) || 0) + 1);
  // Audio is folded into a statement when it is about the same agenda item, or
  // when it has no agenda item and the meeting has exactly one statement.
  const audioByItem = new Map<number, { seconds: number; firstStartTime: number }>();
  const audioOnly: A[] = [];
  for (const appearance of appearances) {
    if (appearance.segmentCount <= 0) continue;
    const itemId = appearance.agendaItemId != null
      ? (statementItems.has(appearance.agendaItemId) ? appearance.agendaItemId : null)
      : statementsByMeeting.get(appearance.meetingId) === 1 ? statements.find((s) => s.meetingId === appearance.meetingId)!.agendaItemId : null;
    if (itemId == null) { audioOnly.push(appearance); continue; }
    const audio = audioByItem.get(itemId);
    audioByItem.set(itemId, audio
      ? { seconds: audio.seconds + appearance.seconds, firstStartTime: Math.min(audio.firstStartTime, appearance.firstStartTime) }
      : { seconds: appearance.seconds, firstStartTime: appearance.firstStartTime });
  }
  const merged: StatementWithAudio[] = statements.map((statement) => ({ ...statement, audio: audioByItem.get(statement.agendaItemId) || null }));

  const meetings = new Set<number>([...appearances.map((a) => a.meetingId), ...statements.map((s) => s.meetingId)]);
  const items = new Set<number>([...statementItems, ...appearances.flatMap((a) => (a.agendaItemId == null ? [] : [a.agendaItemId]))]);
  const dates = [...appearances.map((a) => a.meetingDate), ...statements.map((s) => s.meetingDate)].filter(Boolean).sort();
  return {
    statements: merged,
    audioOnly,
    meetingCount: meetings.size,
    agendaItemCount: items.size,
    firstDate: dates[0] || null,
    lastDate: dates[dates.length - 1] || null,
  };
}

/** Plain-language summary for the page description. */
export function participationSummary(name: string, meetingCount: number, agendaItemCount: number, firstDate: string | null, lastDate: string | null) {
  if (!meetingCount) return `${name}’s recorded participation as a member of the public at Langford council and committee meetings.`;
  const first = firstDate?.slice(0, 4);
  const last = lastDate?.slice(0, 4);
  const span = first && last ? (first === last ? ` in ${first}` : `, ${first}–${last}`) : "";
  const items = agendaItemCount ? `, on ${agendaItemCount} agenda ${agendaItemCount === 1 ? "item" : "items"}` : "";
  return `${name} addressed Langford council as a member of the public at ${meetingCount} ${meetingCount === 1 ? "meeting" : "meetings"}${span}${items}. Read what they said.`;
}
