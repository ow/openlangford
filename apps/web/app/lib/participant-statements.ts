/**
 * What a public participant said or wrote to council: spoken comments from the
 * per-item summaries in `agenda_items.meta.participation.speakers`, and letters
 * from `agenda_items.meta.written_participation` (`documents[].letters`, or a
 * legacy flat `letters` list). Only the pipeline's `person_id` ties an entry to
 * a person (never the `who` string), and the `who` string is never copied out:
 * it can carry a "(Street)" qualifier, and a profile has no need to repeat
 * where someone lives.
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
  /** Where the summary came from, when the pipeline recorded it (spoken comments only). */
  source: "minutes" | "transcript" | null;
  /** A comment made at the meeting, or a letter to council in the agenda package. */
  kind: "spoken" | "written";
  /** The extracted document holding the letter, for "Read the letter" (written only). */
  documentId: number | null;
};

/** Row shape selected by the loader query (see participant-statements.server.ts). */
export type StatementItemRow = {
  id: number;
  title: string | null;
  speakers?: unknown;
  source?: unknown;
  /** `meta.written_participation`. */
  written?: unknown;
  meetings: { id: number; slug?: string | null; title?: string | null; meeting_date?: string | null } | null;
  matter?: { id: number; slug?: string | null; title?: string | null } | null;
};

const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");

type Entry = { entry: Record<string, unknown>; kind: ParticipantStatement["kind"]; documentId: number | null };

function entriesOf(row: StatementItemRow): Entry[] {
  const entries: Entry[] = [];
  if (Array.isArray(row.speakers)) {
    for (const speaker of row.speakers) if (speaker && typeof speaker === "object") entries.push({ entry: speaker as Record<string, unknown>, kind: "spoken", documentId: null });
  }
  const written = row.written && typeof row.written === "object" ? (row.written as Record<string, unknown>) : null;
  const groups = Array.isArray(written?.documents)
    ? (written!.documents as unknown[]).map((doc) => doc as Record<string, unknown> | null)
    : written ? [{ letters: written.letters }] : [];
  for (const group of groups) {
    if (!group || !Array.isArray(group.letters)) continue;
    const documentId = Number.isInteger(group.extracted_document_id) ? (group.extracted_document_id as number) : null;
    for (const letter of group.letters) if (letter && typeof letter === "object") entries.push({ entry: letter as Record<string, unknown>, kind: "written", documentId });
  }
  return entries;
}

const byNewest = (a: ParticipantStatement, b: ParticipantStatement) =>
  b.meetingDate.localeCompare(a.meetingDate) || a.agendaItemId - b.agendaItemId || (a.kind === b.kind ? 0 : a.kind === "spoken" ? -1 : 1);

/** Every linked, past statement in these rows, keyed by person id, newest first. */
export function statementsByPerson(rows: readonly StatementItemRow[], today: string, onlyPersonId?: number): Map<number, ParticipantStatement[]> {
  const byPerson = new Map<number, ParticipantStatement[]>();
  for (const row of rows) {
    const meeting = row.meetings;
    const date = meeting?.meeting_date?.slice(0, 10);
    if (!meeting || !date || date > today) continue;
    const source = row.source === "minutes" || row.source === "transcript" ? row.source : null;
    for (const { entry, kind, documentId } of entriesOf(row)) {
      const personId = Number(entry.person_id);
      if (!Number.isInteger(personId) || personId <= 0 || (onlyPersonId !== undefined && personId !== onlyPersonId)) continue;
      const point = text(entry.point);
      const topic = text(entry.topic);
      if (!point && !topic) continue;
      const list = byPerson.get(personId) || [];
      list.push({
        agendaItemId: row.id,
        agendaTitle: text(row.title) || null,
        meetingId: meeting.id,
        meetingSlug: meeting.slug || null,
        meetingTitle: text(meeting.title) || "Council meeting",
        meetingDate: date,
        matter: row.matter?.id ? { id: row.matter.id, slug: row.matter.slug || null, title: text(row.matter.title) || "Related matter" } : null,
        position: text(entry.position).toLowerCase(),
        topic,
        point,
        source: kind === "spoken" ? source : null,
        kind,
        documentId,
      });
      byPerson.set(personId, list);
    }
  }
  for (const list of byPerson.values()) list.sort(byNewest);
  return byPerson;
}

export function statementsFromItems(rows: readonly StatementItemRow[], personId: number, today: string): ParticipantStatement[] {
  return statementsByPerson(rows, today, personId).get(personId) || [];
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
 * One view of a participant: summarized comments and letters, with any audio
 * attributed to the same agenda item folded into the spoken comment, plus the
 * audio appearances no comment covers. Meetings and agenda items are counted
 * once across every source; letters are also counted on their own.
 */
export function mergeParticipation<A extends Appearance>(appearances: readonly A[], statements: readonly ParticipantStatement[]) {
  const spoken = statements.filter((s) => s.kind !== "written");
  const statementItems = new Set(spoken.map((s) => s.agendaItemId));
  const statementsByMeeting = new Map<number, number>();
  for (const s of spoken) statementsByMeeting.set(s.meetingId, (statementsByMeeting.get(s.meetingId) || 0) + 1);
  // Audio is folded into a statement when it is about the same agenda item, or
  // when it has no agenda item and the meeting has exactly one statement.
  const audioByItem = new Map<number, { seconds: number; firstStartTime: number }>();
  const audioOnly: A[] = [];
  for (const appearance of appearances) {
    if (appearance.segmentCount <= 0) continue;
    const itemId = appearance.agendaItemId != null
      ? (statementItems.has(appearance.agendaItemId) ? appearance.agendaItemId : null)
      : statementsByMeeting.get(appearance.meetingId) === 1 ? spoken.find((s) => s.meetingId === appearance.meetingId)!.agendaItemId : null;
    if (itemId == null) { audioOnly.push(appearance); continue; }
    const audio = audioByItem.get(itemId);
    audioByItem.set(itemId, audio
      ? { seconds: audio.seconds + appearance.seconds, firstStartTime: Math.min(audio.firstStartTime, appearance.firstStartTime) }
      : { seconds: appearance.seconds, firstStartTime: appearance.firstStartTime });
  }
  const merged: StatementWithAudio[] = statements.map((statement) => ({
    ...statement,
    audio: statement.kind === "written" ? null : audioByItem.get(statement.agendaItemId) || null,
  }));

  const meetings = new Set<number>([...appearances.map((a) => a.meetingId), ...statements.map((s) => s.meetingId)]);
  const items = new Set<number>([...statements.map((s) => s.agendaItemId), ...appearances.flatMap((a) => (a.agendaItemId == null ? [] : [a.agendaItemId]))]);
  const letterCount = statements.length - spoken.length;
  const dates = [...appearances.map((a) => a.meetingDate), ...statements.map((s) => s.meetingDate)].filter(Boolean).sort();
  return {
    statements: merged,
    audioOnly,
    meetingCount: meetings.size,
    agendaItemCount: items.size,
    letterCount,
    /** Only letters: no spoken comment and no recorded appearance. */
    lettersOnly: letterCount > 0 && spoken.length === 0 && appearances.length === 0,
    firstDate: dates[0] || null,
    lastDate: dates[dates.length - 1] || null,
  };
}

/** Plain-language summary for the page description. */
export function participationSummary(
  name: string,
  meetingCount: number,
  agendaItemCount: number,
  firstDate: string | null,
  lastDate: string | null,
  letterCount = 0,
  lettersOnly = false,
) {
  if (!meetingCount) return `${name}’s recorded participation as a member of the public at Langford council and committee meetings.`;
  const first = firstDate?.slice(0, 4);
  const last = lastDate?.slice(0, 4);
  const span = first && last ? (first === last ? ` in ${first}` : `, ${first}–${last}`) : "";
  const items = agendaItemCount ? `, on ${agendaItemCount} agenda ${agendaItemCount === 1 ? "item" : "items"}` : "";
  const meetings = `${meetingCount} ${meetingCount === 1 ? "meeting" : "meetings"}`;
  const letters = `${letterCount} ${letterCount === 1 ? "letter" : "letters"}`;
  if (lettersOnly) return `${name} wrote to Langford council as a member of the public: ${letters} for ${meetings}${span}${items}. Read what they wrote.`;
  if (letterCount) return `${name} addressed Langford council as a member of the public at ${meetings}${span}${items}, including ${letters}. Read what they said and wrote.`;
  return `${name} addressed Langford council as a member of the public at ${meetings}${span}${items}. Read what they said.`;
}
