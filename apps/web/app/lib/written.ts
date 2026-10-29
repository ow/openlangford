/**
 * Written participation: residents' letters stored on agenda items as
 * `meta.written_participation = { documents: [{ extracted_document_id, document_id, title, letters }] }`.
 * Letters the pipeline couldn't place wait on the meeting in `meta.written_unplaced`.
 */

export type WrittenLetter = {
  who: string;
  position: string;
  topic: string;
  point: string;
  sent?: string;
  /** Canonical people id stamped by the pipeline (unique full-name match, never council or staff). */
  person_id?: number | null;
};
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
  /** The model's probability that the letter is about no single agenda item. */
  general?: number;
  candidates: { item_id: number; title?: string; probability: number }[];
};
export type UnplacedDocument = { document_id: number; title?: string; fingerprint?: string; letters: HeldLetter[] };

export function writtenLetters(written: WrittenParticipation | null | undefined): WrittenLetter[] {
  if (!written) return [];
  return written.documents ? written.documents.flatMap((d) => d.letters || []) : written.letters || [];
}

type LinkedPerson = { id: number; name?: string | null; slug?: string | null };

/**
 * An agenda item's meta with the linked person (for the profile slug) attached
 * to each public speaker and letter writer that carries a pipeline `person_id`.
 */
export function withLinkedPeople<M extends Record<string, any> | null | undefined>(meta: M, people: Record<number, LinkedPerson | undefined>): M {
  if (!meta) return meta;
  const attach = (entry: any) => (entry?.person_id && people[entry.person_id] ? { ...entry, person: people[entry.person_id] } : entry);
  const speakers = meta.participation?.speakers;
  const written = meta.written_participation as WrittenParticipation | undefined;
  if (!speakers && !written) return meta;
  return {
    ...meta,
    ...(speakers ? { participation: { ...meta.participation, speakers: speakers.map(attach) } } : {}),
    ...(written
      ? {
          written_participation: written.documents
            ? { ...written, documents: written.documents.map((d) => ({ ...d, letters: (d.letters || []).map(attach) })) }
            : { ...written, letters: (written.letters || []).map(attach) },
        }
      : {}),
  };
}

/** Source documents for "Read the letters". The document viewer is keyed by the extracted document, not the PDF. */
export function writtenSources(written: WrittenParticipation | null | undefined) {
  return (written?.documents || []).map((d) => ({ documentId: d.extracted_document_id, title: d.title }));
}

/** Remove a held letter from the meeting's queue and remember the decision. */
export function takeHeld(
  meetingMeta: Record<string, any> | null | undefined,
  extractedId: string,
  key: string,
  itemId: number | null,
  itemTitle?: string | null,
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
  const { key: _key, candidates: _candidates, general: _general, ...letter } = held;
  // Who decided, and a copy of the letter: the pipeline learns from admin decisions (worked examples, evaluation).
  meeting.written_placements = {
    ...(meeting.written_placements || {}),
    [extractedId]: {
      ...(meeting.written_placements?.[extractedId] || {}),
      [key]: {
        item: itemId,
        by: "admin",
        at: new Date().toISOString(),
        ...(itemTitle ? { item_title: itemTitle.slice(0, 160) } : {}),
        letter: { who: letter.who, position: letter.position, topic: letter.topic, point: letter.point },
      },
    },
  };
  return { meetingMeta: meeting, letter: letter as WrittenLetter, source };
}

/**
 * Where letters not about any single agenda item go: the meeting's Correspondence section,
 * else its Public Participation section (mirrors the pipeline's general_item).
 */
export function generalItem<T extends { title: string | null; item_order?: string | null }>(items: T[]): T | null {
  const order = (o?: string | null) => (o || "").match(/\d+/g)?.map(Number) ?? [Infinity];
  const sorted = [...items].sort((a, b) => {
    const [x, y] = [order(a.item_order), order(b.item_order)];
    for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? -1) !== (y[i] ?? -1)) return (x[i] ?? -1) - (y[i] ?? -1);
    return 0;
  });
  for (const pattern of [/^(?:[\d.]+\s*)?correspondence\.?$/i, /^(?:[\d.]+\s*)?public participation\.?$/i]) {
    const found = sorted.find((it) => pattern.test((it.title || "").trim()));
    if (found) return found;
  }
  return null;
}

/** Add letters from one source document to an item's written participation. */
export function addToItem(
  itemMeta: Record<string, any> | null | undefined,
  extractedId: string,
  source: Pick<UnplacedDocument, "document_id" | "title" | "fingerprint">,
  letters: WrittenLetter[],
) {
  const item = { ...(itemMeta || {}) };
  const written: WrittenParticipation = { ...(item.written_participation || {}) };
  const documents = [...(written.documents || [])];
  const index = documents.findIndex((d) => String(d.extracted_document_id) === extractedId);
  if (index >= 0) documents[index] = { ...documents[index], letters: [...documents[index].letters, ...letters] };
  else
    documents.push({
      extracted_document_id: Number(extractedId),
      document_id: source.document_id,
      title: source.title,
      fingerprint: source.fingerprint,
      letters,
    });
  return { ...item, written_participation: { ...written, documents } };
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
  const taken = takeHeld(meetingMeta, extractedId, key, itemId);
  if (!taken) return null;
  const item = itemId != null && itemMeta ? addToItem(itemMeta, extractedId, taken.source, [taken.letter]) : itemMeta ? { ...itemMeta } : null;
  return { meetingMeta: taken.meetingMeta, itemMeta: item };
}

/**
 * A short label that keeps what tells similar items apart:
 * BYLAW NO. 2008 "Langford Zoning Bylaw, Amendment No. 641, (808, 812 Arncote Avenue …)" -> "Bylaw 2008 · 808, 812 Arncote Avenue …".
 */
export function shortItemLabel(order: string | null | undefined, title: string, max = 60) {
  let clean = title.replace(/\s+/g, " ").trim();
  const bylaw = clean.match(/\bbylaw\s*(?:no\.?)?\s*(\d{3,5})\b/i);
  const brackets = [...clean.matchAll(/\(([^()]{6,})\)/g)].map((m) => m[1]);
  const stage = brackets.find((b) => /readings?|adoption|public hearing/i.test(b));
  const subject = brackets.find((b) => b !== stage);
  const quoted = clean.match(/["“]([^"”]+)["”]/)?.[1];
  if (bylaw) {
    const what = subject || quoted?.replace(/,?\s*Bylaw No\.?\s*\d+,?\s*\d{4}$/i, "") || "";
    const parts = [`Bylaw ${bylaw[1]}`, stage?.toLowerCase(), what].filter(Boolean);
    clean = parts.join(" · ");
  }
  const text = clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
  return order ? `${order} ${text}` : text;
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

/** Identifiers that tie a letter to an agenda item when both mention them (mirrors the pipeline's specific_terms). */
export function specificTerms(text: string) {
  const found = new Set<string>();
  for (const m of text.matchAll(/\b(?:bylaw|by-law)\s*(?:no\.?\s*)?(\d{3,5})\b/gi)) found.add(`Bylaw ${m[1]}`);
  for (const m of text.matchAll(/\b((?:Z|OCP|DVP|DP|TUP|SUB|RZ)\d{2}-\d{3,4})\b/gi)) found.add(m[1].toUpperCase());
  for (const m of text.matchAll(/\b((?:BP|RS|RT|CD|CC|CS|MU|RM|R|C|M|P)\d{1,2})\b/g)) found.add(m[1]);
  const types: Record<string, string> = { road: "Rd", street: "St", avenue: "Ave", drive: "Dr", place: "Pl", crescent: "Cres", lane: "Ln", parkway: "Pkwy" };
  for (const m of text.matchAll(/\b(\d{3,5}\s+(?:[A-Z][a-z]+\s){1,3}(?:Road|Rd|Street|St|Avenue|Ave|Drive|Dr|Way|Place|Pl|Crescent|Cres|Lane|Ln|Parkway|Pkwy))\b/g)) {
    const words = m[1].split(/\s+/);
    const last = words.at(-1)!;
    found.add([...words.slice(0, -1), types[last.toLowerCase()] ?? last].join(" "));
  }
  found.delete("877 Goldstream Ave"); // city hall letterhead: on every letter, identifies nothing
  return found;
}
