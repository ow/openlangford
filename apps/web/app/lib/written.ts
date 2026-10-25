/**
 * Written participation: residents' letters stored on agenda items as
 * `meta.written_participation = { documents: [{ extracted_document_id, document_id, title, letters }] }`.
 * Letters the pipeline couldn't place wait on the meeting in `meta.written_unplaced`.
 */

export type WrittenLetter = { who: string; position: string; topic: string; point: string; sent?: string };
export type WrittenDocument = {
  extracted_document_id: number;
  document_id: number;
  title?: string;
  fingerprint?: string;
  letters: WrittenLetter[];
};
export type WrittenParticipation = { version?: string; documents?: WrittenDocument[]; letters?: WrittenLetter[] };
export type HeldLetter = WrittenLetter & {
  key: string;
  candidates: { item_id: number; title?: string; probability: number }[];
};
export type UnplacedDocument = { document_id: number; title?: string; fingerprint?: string; letters: HeldLetter[] };

export function writtenLetters(written: WrittenParticipation | null | undefined): WrittenLetter[] {
  if (!written) return [];
  return written.documents ? written.documents.flatMap((d) => d.letters || []) : written.letters || [];
}

export function writtenSources(written: WrittenParticipation | null | undefined) {
  return (written?.documents || []).map((d) => ({ documentId: d.document_id, title: d.title }));
}

/**
 * Admin decision on a held letter: move it onto the chosen item (or drop it),
 * remember the decision so reruns respect it, and clear it from the queue.
 */
export function placeHeldLetter(
  meetingMeta: Record<string, any> | null | undefined,
  itemMeta: Record<string, any> | null | undefined,
  extractedId: string,
  key: string,
  itemId: number | null,
) {
  const meeting = { ...(meetingMeta || {}) };
  const unplaced: Record<string, UnplacedDocument> = { ...(meeting.written_unplaced || {}) };
  const source = unplaced[extractedId];
  const held = source?.letters.find((l) => l.key === key);
  if (!source || !held) return null;

  const rest = source.letters.filter((l) => l.key !== key);
  if (rest.length) unplaced[extractedId] = { ...source, letters: rest };
  else delete unplaced[extractedId];
  if (Object.keys(unplaced).length) meeting.written_unplaced = unplaced;
  else delete meeting.written_unplaced;
  meeting.written_placements = {
    ...(meeting.written_placements || {}),
    [extractedId]: { ...(meeting.written_placements?.[extractedId] || {}), [key]: itemId },
  };

  let item = itemMeta ? { ...itemMeta } : null;
  if (itemId != null && item) {
    const { key: _key, candidates: _candidates, ...letter } = held;
    const written: WrittenParticipation = { ...(item.written_participation || {}) };
    const documents = [...(written.documents || [])];
    const index = documents.findIndex((d) => String(d.extracted_document_id) === extractedId);
    if (index >= 0) documents[index] = { ...documents[index], letters: [...documents[index].letters, letter] };
    else
      documents.push({
        extracted_document_id: Number(extractedId),
        document_id: source.document_id,
        title: source.title,
        fingerprint: source.fingerprint,
        letters: [letter],
      });
    item = { ...item, written_participation: { ...written, documents } };
  }
  return { meetingMeta: meeting, itemMeta: item };
}

function nameWords(who: string) {
  // "Mary Wagner (Deville Road)", "Courtney Frechette, Honeycomb Cannabis", "M. Wagner"
  const name = who.replace(/\s*\([^()]*\)\s*$/, "").split(",")[0];
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .match(/[a-z]+(?:['’-][a-z]+)*/g) ?? [];
}

/** Same person by name: same surname and a compatible first name or initial. Anonymous labels never match. */
export function samePerson(a: string, b: string) {
  if (/^a resident\b/i.test(a) || /^a resident\b/i.test(b)) return false;
  const x = nameWords(a);
  const y = nameWords(b);
  if (x.length < 2 || y.length < 2 || x.at(-1) !== y.at(-1)) return false;
  const [p, q] = [x[0]!, y[0]!];
  return p.length === 1 || q.length === 1 ? p[0] === q[0] : p === q;
}

/** Marks people who both spoke and wrote in, for "also spoke" / "also wrote in" notes. */
export function crossNotes(speakers: { who: string }[], letters: { who: string }[]) {
  return {
    speaker: (who: string) => (letters.some((l) => samePerson(who, l.who)) ? "also wrote in" : null),
    letter: (who: string) => (speakers.some((s) => samePerson(who, s.who)) ? "also spoke" : null),
  };
}
