import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * The signed bylaw as a record for the page check and the fix agent.
 *
 * A signed, certified bylaw prints the dates it was read and adopted ("READ A FIRST TIME this 18th day of April,
 * 2016 … ADOPTED this 2nd day of May, 2016"). That is the City's own record of a bylaw's progress, and it settles
 * the question when the minutes' motion wording is wrong (the May 2, 2016 minutes say "give Bylaw No. 1628 First
 * Reading" under an "(ADOPTION)" heading; the signed bylaw says adopted that day). Both agents read minutes and
 * motions; without this they never saw the bylaw itself.
 */

export type BylawDates = { first?: string; second?: string; third?: string; adopted?: string; rescinded?: string };

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

/** "18th day of April, 2016" (OCR tolerant: '2"d day of May, 2016', 'this 18th  day of April 2016') → "April 18, 2016". */
function dateAfter(text: string, at: number): string | undefined {
  const m = text.slice(at, at + 90).match(/(\d{1,2})\s*\S{0,3}\s*day\s+of\s+([A-Za-z]+)[,.]?\s*(\d{4})/i);
  if (!m) return undefined;
  const month = m[2].toLowerCase();
  const idx = MONTHS.findIndex((name) => name.startsWith(month.slice(0, 3)));
  if (idx < 0) return undefined;
  const day = Number(m[1]);
  if (day < 1 || day > 31) return undefined;
  return `${MONTHS[idx][0].toUpperCase()}${MONTHS[idx].slice(1)} ${day}, ${m[3]}`;
}

/** The reading and adoption dates printed on a signed bylaw; empty when none are legible. */
export function parseBylawDates(fullText: string | null | undefined): BylawDates {
  const text = (fullText || "").replace(/\s+/g, " ");
  const out: BylawDates = {};
  // "READ A FIRST TIME this…", "READ A FIRST, SECOND AND THIRD TIME this…", "Read a first and second time on this…"
  for (const m of text.matchAll(/READ\s+A\s+((?:FIRST|SECOND|THIRD)(?:\s*,?\s*(?:AND\s+)?(?:SECOND|THIRD))*)\s+TIMES?\b/gi)) {
    const date = dateAfter(text, m.index! + m[0].length);
    if (!date) continue;
    for (const which of m[1].toLowerCase().match(/first|second|third/g) || []) {
      const key = which as "first" | "second" | "third";
      if (!out[key]) out[key] = date;
    }
  }
  for (const m of text.matchAll(/\b(RECONSIDERED,?\s+(?:FINALLY\s+PASSED\s+)?AND\s+)?(?:FINALLY\s+)?ADOPTED\b/gi)) {
    const date = dateAfter(text, m.index! + m[0].length);
    if (date && !out.adopted) out.adopted = date;
  }
  const r = text.match(/\bRESCINDED\b/i);
  if (r) out.rescinded = dateAfter(text, r.index! + r[0].length);
  return out;
}

export function bylawDatesLine(d: BylawDates): string {
  const parts = [d.first && `read a first time ${d.first}`, d.second && `a second time ${d.second}`, d.third && `a third time ${d.third}`,
    d.adopted && `adopted ${d.adopted}`, d.rescinded && `rescinded ${d.rescinded}`].filter(Boolean);
  if (!parts.length) return "the signed copy's reading and adoption dates are not legible.";
  // Readings without an adoption line: say so, rather than let a reader take the silence as "not adopted".
  return `${parts.join("; ")}${d.adopted ? "" : "; no adoption date is legible on the signed copy"}.`;
}

type BylawRow = { id: number; bylaw_number: string | null; title: string | null; full_text: string | null };

export function bylawRecordLine(b: BylawRow): string {
  return `SIGNED BYLAW bylaw:${b.id} (Bylaw No. ${b.bylaw_number || "?"}, "${b.title || "untitled"}"): ${bylawDatesLine(parseBylawDates(b.full_text))}`;
}

export const SIGNED_BYLAW_NOTE = "SIGNED BYLAW lines come from the certified bylaw on file, the City's own record of when it was read and adopted. "
  + "They outrank a motion's wording in the minutes: when the minutes say \"first reading\" on the day the signed bylaw says it was adopted, the bylaw was adopted.";

/** Bylaw numbers named in a topic's title and identifier ("Bylaw No. 1628; Bylaw No. 1629"). */
export function bylawNumbersIn(...texts: (string | null | undefined)[]): string[] {
  return [...new Set(texts.flatMap((t) => [...(t || "").matchAll(/\bBylaw\s+No\.?\s*(\d{2,5})\b/gi)].map((m) => m[1])))];
}

/** The signed bylaws behind a topic (its bylaw link, and any bylaw number its title or identifier names). */
export async function topicBylaws(supabase: SupabaseClient, matterId: number): Promise<BylawRow[]> {
  const { data: m } = await supabase.from("matters").select("title, identifier, bylaw_id").eq("id", matterId).maybeSingle();
  if (!m) return [];
  const numbers = bylawNumbersIn(m.title, m.identifier);
  const filters = [m.bylaw_id ? `id.eq.${m.bylaw_id}` : "", numbers.length ? `bylaw_number.in.(${numbers.join(",")})` : ""].filter(Boolean);
  if (!filters.length) return [];
  const { data } = await supabase.from("bylaws").select("id, bylaw_number, title, full_text").or(filters.join(",")).order("id");
  return ((data || []) as BylawRow[]);
}

/** The records block for a topic's signed bylaws, or "" when it has none. */
export async function bylawRecords(supabase: SupabaseClient, matterId: number): Promise<string> {
  const rows = await topicBylaws(supabase, matterId).catch(() => [] as BylawRow[]);
  if (!rows.length) return "";
  return [`${SIGNED_BYLAW_NOTE}`, ...rows.map(bylawRecordLine)].join("\n");
}

const BYLAW_TEXT_LIMIT = 6000;

/** One signed bylaw in full (dates first, then the text), for `readRecord("bylaw:<id>")`. */
export async function readBylaw(supabase: SupabaseClient, id: number): Promise<string | null> {
  const { data } = await supabase.from("bylaws").select("id, bylaw_number, title, full_text").eq("id", id).maybeSingle();
  if (!data) return null;
  const text = (data.full_text || "").trim();
  return `${bylawRecordLine(data as BylawRow)}\n${SIGNED_BYLAW_NOTE}\n\n${text.slice(0, BYLAW_TEXT_LIMIT)}${text.length > BYLAW_TEXT_LIMIT ? "\n[…]" : ""}`;
}

/** Signed bylaws matching a research query: by number when it names one, else by words in the title. */
export async function searchBylaws(supabase: SupabaseClient, query: string): Promise<BylawRow[]> {
  const numbers = [...new Set([...query.matchAll(/\b(\d{3,5})\b/g)].map((m) => m[1]))];
  const words = query.toLowerCase().split(/\W+/).filter((w) => w.length > 3 && !/^\d+$/.test(w)).slice(0, 4);
  const filters = [numbers.length ? `bylaw_number.in.(${numbers.join(",")})` : "", ...words.map((w) => `title.ilike.%${w}%`)].filter(Boolean);
  if (!filters.length) return [];
  const { data } = await supabase.from("bylaws").select("id, bylaw_number, title, full_text").or(filters.join(",")).limit(8);
  return ((data || []) as BylawRow[]);
}
