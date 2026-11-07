import glossary from "../../../../shared/glossary.json";

/** Council terms (shared/glossary.json): the public page, the timeline's stage lines and the AI prompt blocks
 * all read this one file. Browser-safe. */
export interface GlossaryTerm {
  id: string;
  term: string;
  /** What it means, for a resident. */
  means: string;
  /** How Langford's minutes and agendas phrase it. */
  in_the_record?: string;
  /** The plain words this site uses for it (docs/writing-style.md). */
  we_write?: string;
  /** Timeline stage key → the one-line explanation shown under a topic's step. */
  stages?: Record<string, string>;
  /** Case-insensitive regex for the word forms pages show; set on the terms residents trip over. */
  match?: string;
}

export interface GlossaryGroup {
  id: string;
  title: string;
  intro?: string;
  terms: GlossaryTerm[];
}

export const GLOSSARY = glossary as { version: number; groups: GlossaryGroup[] };
export const GLOSSARY_VERSION = GLOSSARY.version;
export const GLOSSARY_PATH = "/how-council-works";
export const GLOSSARY_TERMS: GlossaryTerm[] = GLOSSARY.groups.flatMap((g) => g.terms);

export function glossaryTerm(id: string): GlossaryTerm | undefined {
  return GLOSSARY_TERMS.find((t) => t.id === id);
}

/** Link to a term's entry on the public page. */
export function glossaryHref(id: string): string {
  return `${GLOSSARY_PATH}#${id}`;
}

/** The stages a timeline step can be given by hand (agenda_items.meta.staff_stage, set by the fix agent's
 * set_stage when the wording-based guess is wrong). Each key's line lives on the glossary term it belongs to. */
export const STAGE_KEYS = [
  "rescinded_adoption",
  "rescinded_reading",
  "rescinded",
  "adopted",
  "second_third",
  "third",
  "public_hearing",
  "second",
  "first",
] as const;
export type StageKey = (typeof STAGE_KEYS)[number];

const stageLines = new Map<string, { label: string; termId: string }>();
for (const t of GLOSSARY_TERMS) {
  for (const [key, label] of Object.entries(t.stages ?? {})) stageLines.set(key, { label, termId: t.id });
}
for (const key of STAGE_KEYS) {
  if (!stageLines.has(key)) throw new Error(`shared/glossary.json has no stage line for "${key}"`);
}

/** Plain-language line residents see for each stage, keyed by stage. */
export const STAGE_LABELS = Object.fromEntries(STAGE_KEYS.map((k) => [k, stageLines.get(k)!.label])) as Record<StageKey, string>;

/** The glossary term a stage line belongs to, so the line can link to its entry. */
export function stageTermId(label: string | null | undefined): string | null {
  if (!label) return null;
  for (const { label: l, termId } of stageLines.values()) if (l === label) return termId;
  return null;
}

/** Terms that get an inline hint (dashed underline, hover definition, link) where they appear in page text. */
export const HINT_TERMS: { term: GlossaryTerm; re: RegExp }[] = GLOSSARY_TERMS.filter((t) => t.match).map((t) => ({
  term: t,
  re: new RegExp(t.match!, "i"),
}));

export type TermSegment = { text: string; term?: GlossaryTerm };

/** Split `text` into plain runs and the first occurrence of each hinted term (ids in `skip` are left plain).
 * Each term is matched at most once per call; callers track what a page has already shown. */
export function splitTerms(text: string, skip: ReadonlySet<string> = new Set()): TermSegment[] {
  const hits: { start: number; end: number; term: GlossaryTerm }[] = [];
  for (const { term, re } of HINT_TERMS) {
    if (skip.has(term.id)) continue;
    const m = re.exec(text);
    if (m && m[0]) hits.push({ start: m.index, end: m.index + m[0].length, term });
  }
  hits.sort((a, b) => a.start - b.start || b.end - a.end);
  const out: TermSegment[] = [];
  let pos = 0;
  for (const h of hits) {
    if (h.start < pos) continue; // overlaps an earlier hit
    if (h.start > pos) out.push({ text: text.slice(pos, h.start) });
    out.push({ text: text.slice(h.start, h.end), term: h.term });
    pos = h.end;
  }
  if (pos < text.length) out.push({ text: text.slice(pos) });
  return out;
}
