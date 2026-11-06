import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { getAiClient } from "./ai/index.server";
import { completeVoteCounts } from "../lib/vote-coverage";
import type { PageFlag } from "../lib/page-review-types";
import { research } from "./record-research.server";

/**
 * The page check's second reading: the page's own statements against the records behind them. A topic page's
 * summary, "where it stands" line and timeline lines, or a meeting page's item summaries and highlights, go to the
 * review model with each item's motions (text, outcome, complete vote counts), the key facts of its attached
 * reports and its minutes text. One call per page; it answers per statement, and what isn't backed by the records
 * (or contradicts them) becomes an "unsupported" flag that quotes what the record does say.
 */

type Claim = { id: string; key: string | null; text: string };
/** Records are never cut to fit: a model that sees only part of a report flags true figures as unconfirmed. A page whose
 * records would overflow the review model's context fails openly instead (about 3 million characters, far beyond any
 * real page). */
export const RECORD_LIMIT = 3_000_000;
const KEY_SECTION = /purpose|executive summary|proposal|comment|recommendation|summary|background|discussion|financial/i;

const VerifySchema = z.object({
  verdicts: z.array(z.object({
    id: z.string().describe("The statement's id exactly as given."),
    verdict: z.enum(["supported", "not_in_record", "contradicted", "cannot_check"]),
    source: z.string().nullable().describe("The words in the records that support or contradict it, quoted; null when nothing does."),
    reason: z.string().describe("One plain sentence an editor would understand."),
    fix: z.string().nullable().describe("What should change, as one instruction an editor can approve: e.g. \"Remove this entry from the page\", \"Move this item to the 2022 budget topic\", \"Rewrite the status to say Council rescinded the direction on Nov 4, 2024\", \"Merge with the Shared micromobility parking and licence topic\"." + " Null when supported."),
  })),
});

/** A text's sentences. A sentence ends at ".", "!" or "?" followed by a space and a capital (or the end), never at
 * a decimal point or an abbreviation inside a figure: "$4,408,940.67" split there had read as "67 plus GST". */
export const sentences = (text: string) =>
  text.split(/(?<=[.!?])\s+(?=[A-Z0-9“"‘'(])/).map((s) => s.trim()).filter((s) => s.length > 3);

/** The words that name an item's subject ("REPORTS — Affordable Housing Policy - Staff Report (File …)" → its
 * subject), as a pattern that finds it in minutes or report text whatever the punctuation between words. */
function subjectPattern(title: string): RegExp | null {
  const first = String(title || "").split("\n")[0];
  const subject = (first.includes(" — ") ? first.slice(first.indexOf(" — ") + 3) : first)
    .replace(/^[A-Z][A-Z ,&'/]+\s+[a-z]\)\s+/, "")  // "BYLAWS j) BYLAW NO. 1966 …": the section and its letter
    .replace(/\(File[^)]*\)?/gi, "").replace(/\s+-\s+(Staff Report|Report|Memo|Letter|Presentation)\b.*$/i, "");
  const words = subject.match(/[A-Za-z0-9]+/g) || [];
  if (words.length < 2) return null;
  return new RegExp(words.slice(0, 6).map((w) => w.replace(/[^A-Za-z0-9]/g, "")).join("\\W+"), "i");
}

/** Records for each item, and which items have any. Older imports often left the minutes and reports unattached
 * to their agenda items; for those, the same meeting's unattached text is searched for the item's subject. */
/** Every row of a query, page by page (the API returns at most 1,000 at a time). */
export async function fetchAll<T = any>(build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: any }>): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build(from, from + 999);
    if (error) throw error;
    rows.push(...(data || []));
    if (!data || data.length < 1000) return rows;
  }
}

/** A topic's own agenda items. */
export async function topicItemIds(supabase: SupabaseClient, matterId: number): Promise<number[]> {
  const rows = await fetchAll<{ id: number }>((from, to) =>
    supabase.from("agenda_items").select("id").eq("matter_id", matterId).order("id").range(from, to));
  return rows.map((r) => r.id);
}

/** Records for each item, and which items have any. Older imports often left the minutes and reports unattached
 * to their agenda items; for those, the same meeting's unattached text is searched for the item's subject. Nothing is
 * cut: motions, report text and minutes go in whole. */
export async function itemRecords(supabase: SupabaseClient, itemIds: number[]): Promise<{ text: string; covered: Set<number> }> {
  const covered = new Set<number>();
  if (!itemIds.length) return { text: "", covered };
  const chunks = Array.from({ length: Math.ceil(itemIds.length / 200) }, (_, i) => itemIds.slice(i * 200, i * 200 + 200));
  const each = async <T,>(build: (ids: number[], from: number, to: number) => PromiseLike<{ data: T[] | null; error: any }>) =>
    (await Promise.all(chunks.map((ids) => fetchAll<T>((from, to) => build(ids, from, to))))).flat();
  const [items, motions, docs, sections] = await Promise.all([
    each<any>((ids, from, to) => supabase.from("agenda_items").select("id, meeting_id, title, plain_english_summary, meetings(meeting_date)").in("id", ids).order("id").range(from, to)),
    each<any>((ids, from, to) => supabase.from("motions").select("id, agenda_item_id, text_content, result, mover, seconder, meta, votes(person_id, vote)").in("agenda_item_id", ids).order("id").range(from, to)),
    each<any>((ids, from, to) => supabase.from("extracted_documents").select("agenda_item_id, title, key_facts").in("agenda_item_id", ids).order("id").range(from, to)),
    each<any>((ids, from, to) => supabase.from("document_sections").select("id, agenda_item_id, section_title, section_text, section_order").in("agenda_item_id", ids)
      .order("section_order").order("id").range(from, to)),
  ]);
  const has = (id: number) => [motions, docs, sections].some((rows) => rows.some((r) => r.agenda_item_id === id));
  const bare = items.filter((i) => !has(i.id) && i.meeting_id);
  const loose = new Map<number, string[]>();  // meeting → its unattached minutes/report text
  if (bare.length) {
    const meetingDocs = await fetchAll<any>((from, to) => supabase.from("documents").select("id, meeting_id")
      .in("meeting_id", [...new Set(bare.map((i) => i.meeting_id))]).order("id").range(from, to));
    const docMeeting = new Map(meetingDocs.map((d) => [d.id, d.meeting_id]));
    if (docMeeting.size) {
      const free = await fetchAll<any>((from, to) => supabase.from("document_sections").select("document_id, section_text")
        .in("document_id", [...docMeeting.keys()]).is("agenda_item_id", null).order("section_order").order("id").range(from, to));
      for (const s of free) {
        const mid = docMeeting.get(s.document_id);
        if (mid && s.section_text) loose.set(mid, [...(loose.get(mid) || []), s.section_text]);
      }
    }
  }
  const out: string[] = [];
  for (const item of items) {
    const meeting = Array.isArray(item.meetings) ? item.meetings[0] : item.meetings;
    const lines = [`ITEM ${item.id} (${meeting?.meeting_date ?? "date unknown"}): ${String(item.title || "").split("\n")[0]}`];
    for (const m of motions.filter((m) => m.agenda_item_id === item.id)) {
      const counts = completeVoteCounts(m);
      const opposed = (m.votes || []).filter((v: any) => v.vote === "No").length;
      lines.push(`  MOTION: ${String(m.text_content || "")} | RESULT: ${m.result || "not recorded"}` +
        `${counts ? ` | VOTE ${counts.yes}–${counts.no}` : opposed ? ` | ${opposed} named as opposed (full vote not recorded)` : ""}` +
        `${m.mover ? ` | moved by ${m.mover}` : ""}${m.seconder ? `, seconded by ${m.seconder}` : ""}`);
    }
    for (const d of docs.filter((d) => d.agenda_item_id === item.id)) {
      const facts = Array.isArray(d.key_facts) ? d.key_facts.join("; ") : "";
      // Extracted by a model from the report: a pointer to what the report covers, not the report's words.
      if (facts) lines.push(`  NOTES (model-extracted from report "${d.title}"): ${facts}`);
    }
    const text = sections.filter((s) => s.agenda_item_id === item.id)
      .map((s) => `${s.section_title ? `${s.section_title}: ` : ""}${s.section_text || ""}`).join(" ").replace(/\s+/g, " ");
    if (text) lines.push(`  DOCUMENT TEXT: ${text}`);
    const pattern = !has(item.id) ? subjectPattern(item.title) : null;
    if (pattern) {
      // Each unattached minutes or report section of the same meeting that names the item's subject, whole.
      for (const t of (loose.get(item.meeting_id) || []).filter((t) => pattern.test(t))) {
        lines.push(`  MINUTES OR REPORT TEXT FROM THIS MEETING: ${t.replace(/\s+/g, " ")}`);
      }
    }
    if (lines.length > 1) covered.add(item.id);
    else lines.push("  (no minutes, motions or reports found for this item)");
    out.push(lines.join("\n"));
  }
  const text = out.join("\n\n");
  if (text.length > RECORD_LIMIT) throw new Error(`The records behind this page are ${text.length.toLocaleString()} characters, more than the review model can read at once.`);
  return { text, covered };
}

/** The statements a page makes and the records behind them, for a topic or a meeting page; null for others. */
export async function claimsAndRecords(supabase: SupabaseClient, path: string): Promise<{ claims: Claim[]; records: string } | null> {
  const topic = path.match(/^\/matters\/([^/]+)$/)?.[1];
  const meeting = path.match(/^\/meetings\/([^/]+)$/)?.[1];
  if (topic) {
    const { data: m } = await supabase.from("matters").select("id, plain_english_summary, meta").eq("slug", topic).maybeSingle();
    if (!m) return null;
    const meta = (m.meta || {}) as Record<string, any>;
    const ids = await topicItemIds(supabase, m.id);
    const claims: Claim[] = [
      ...sentences(m.plain_english_summary || "").map((t, i) => ({ id: `summary-${i}`, key: null, text: `Summary: ${t}` })),
      ...(meta.status_line ? [{ id: "status", key: null, text: `Where it stands: ${meta.status_line}` }] : []),
      ...Object.entries((meta.timeline_headlines || {}) as Record<string, string>)
        .filter(([id]) => ids.includes(Number(id))).map(([id, t]) => ({ id: `line-${id}`, key: `agenda-${id}`, text: `Timeline line for item ${id}: ${t}` })),
    ];
    const records = await itemRecords(supabase, ids);
    // Only statements there's something to check against: a line about an item with no records is left alone,
    // and the summary and status only when at least one item has records.
    const checkable = claims.filter((c) => c.id.startsWith("line-") ? records.covered.has(Number(c.id.slice(5))) : records.covered.size > 0);
    return { claims: checkable, records: records.text };
  }
  if (meeting) {
    const { data: mt } = await supabase.from("meetings").select("id, meta").eq("slug", meeting).maybeSingle();
    if (!mt) return null;
    const list = await fetchAll<any>((from, to) => supabase.from("agenda_items").select("id, plain_english_summary").eq("meeting_id", mt.id).order("id").range(from, to));
    const bullets = ((mt.meta as any)?.highlights?.bullets || []) as string[];
    const claims: Claim[] = [
      ...bullets.map((t, i) => ({ id: `highlight-${i}`, key: null, text: `Meeting highlight: ${t}` })),
      ...list.filter((i) => i.plain_english_summary).map((i) => ({ id: `item-${i.id}`, key: `item-${i.id}`, text: `Summary of item ${i.id}: ${i.plain_english_summary}` })),
    ];
    const records = await itemRecords(supabase, list.map((i) => i.id));
    const checkable = claims.filter((c) => c.id.startsWith("item-") ? records.covered.has(Number(c.id.slice(5))) : records.covered.size > 0);
    return { claims: checkable, records: records.text };
  }
  return null;
}

/** Flags for the page's statements that its records don't back. Empty when the page has no checkable statements. */
export async function verifyAgainstRecords(supabase: SupabaseClient, path: string): Promise<PageFlag[]> {
  const input = await claimsAndRecords(supabase, path);
  if (!input || !input.claims.length || !input.records) return [];
  const prompt = `You check a page of Open Langford (a site that follows Langford City council) against the council's own
records. For each numbered statement the page makes, say whether the records support it:
Lines marked NOTES were written by a model from a report and may be wrong: they can tell you what a report covers, but
a statement only a NOTES line backs is not_in_record ("only in a model-written summary of the report").
- supported: the records say this (paraphrase is fine; a reasonable plain-language summary of a motion is supported).
- not_in_record: nothing in the records says it (an invented detail, a number or outcome the records don't give).
- contradicted: the records say something different (a different address, count, outcome, date or step).
- cannot_check: the records given are too thin to judge it (only a title, or text that doesn't cover this
  part of the item). Missing records are not a problem with the page: use this, never not_in_record, when the
  records simply don't reach that far.
Judge facts, not style. What follows from what something is, or from how a city council works, needs no record
(development cost charges pay for growth's roads and parks; a public hearing is where residents speak; a bylaw
adopted is in force): call it supported. Check what is specific to this item: its numbers, dates, places, steps,
purpose and outcome. Quote the record's words in "source" whenever you can.

STATEMENTS
${input.claims.map((c) => `[${c.id}] ${c.text}`).join("\n")}

RECORDS
${input.records}`;
  const result = await getAiClient().json({ stage: "verify", prompt, schema: VerifySchema, schemaName: "page_verify" });
  const byId = new Map(input.claims.map((c) => [c.id, c]));
  const doubted = result.data.verdicts.filter((v) => (v.verdict === "not_in_record" || v.verdict === "contradicted") && byId.has(v.id));
  // Before anything is flagged, the reviewer researches it in all of the City's records: a figure missing from the
  // records filed on this page is often in a report filed under another meeting, or said on video.
  const findings = await mapLimit(doubted, 4, (v) => research(supabase,
    `Does the City's record support this statement on ${path}: "${byId.get(v.id)!.text}"?`,
    `The records filed on this page ${v.verdict === "contradicted" ? "seem to contradict it" : "don't contain it"}: ${v.reason}` +
      `${v.source ? ` They say: "${v.source}"` : ""}`).catch(() => null));
  return doubted.flatMap((v, i) => {
    const claim = byId.get(v.id)!;
    const found = findings[i];
    if (found?.verdict === "supported") return [];
    const contradicted = found?.verdict === "contradicted" || (!found && v.verdict === "contradicted");
    const said = found?.quote ? `${found.quote}${found.ref ? ` (${found.ref})` : ""}` : v.source;
    return [{
      key: claim.key, problem: "unsupported" as const, verdict: null, fix: v.fix,
      reason: `${contradicted ? "Contradicted by the record" : "Not in the record"}: ${found ? found.explanation : v.reason}` +
        `${said ? ` The record says: “${said}”` : ""}${found ? " (searched all of the City's records)" : ""}`,
      excerpt: claim.text,
      ...(found ? { research: { verdict: found.verdict, explanation: found.explanation, quote: found.quote, ref: found.ref } } : {}),
    }];
  });
}

/** Run `fn` over `items` with at most `limit` running at once, results in order. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]); }
  }));
  return out;
}
