import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { getAiClient } from "./ai/index.server";
import { completeVoteCounts } from "../lib/vote-coverage";
import type { PageFlag } from "../lib/page-review-types";

/**
 * The page check's second reading: the page's own statements against the records behind them. A topic page's
 * summary, "where it stands" line and timeline lines, or a meeting page's item summaries and highlights, go to the
 * review model with each item's motions (text, outcome, complete vote counts), the key facts of its attached
 * reports and its minutes text. One call per page; it answers per statement, and what isn't backed by the records
 * (or contradicts them) becomes an "unsupported" flag that quotes what the record does say.
 */

type Claim = { id: string; key: string | null; text: string };
const RECORD_CAP = 120_000;  // characters of records per page; a big meeting's minutes are the long part

const VerifySchema = z.object({
  verdicts: z.array(z.object({
    id: z.string().describe("The statement's id exactly as given."),
    verdict: z.enum(["supported", "not_in_record", "contradicted", "cannot_check"]),
    source: z.string().nullable().describe("The words in the records that support or contradict it, quoted; null when nothing does."),
    reason: z.string().describe("One plain sentence an editor would understand."),
    fix: z.string().nullable().describe("What should change, as one instruction an editor can approve: e.g. \"Remove this entry from the page\", \"Move this item to the 2022 budget topic\", \"Rewrite the status to say Council rescinded the direction on Nov 4, 2024\", \"Merge with the Shared micromobility parking and licence topic\"." + " Null when supported."),
  })),
});

const sentences = (text: string) => (text.match(/[^.!?]+[.!?]+(\s|$)|[^.!?]+$/g) || []).map((s) => s.trim()).filter((s) => s.length > 3);

/** The words that name an item's subject ("REPORTS — Affordable Housing Policy - Staff Report (File …)" → its
 * subject), as a pattern that finds it in minutes or report text whatever the punctuation between words. */
function subjectPattern(title: string): RegExp | null {
  const first = String(title || "").split("\n")[0];
  const subject = (first.includes(" — ") ? first.slice(first.indexOf(" — ") + 3) : first)
    .replace(/\(File[^)]*\)?/gi, "").replace(/\s+-\s+(Staff Report|Report|Memo|Letter|Presentation)\b.*$/i, "");
  const words = subject.match(/[A-Za-z0-9]+/g) || [];
  if (words.length < 2) return null;
  return new RegExp(words.slice(0, 6).map((w) => w.replace(/[^A-Za-z0-9]/g, "")).join("\\W+"), "i");
}

/** Records for each item, and which items have any. Older imports often left the minutes and reports unattached
 * to their agenda items; for those, the same meeting's unattached text is searched for the item's subject. */
async function itemRecords(supabase: SupabaseClient, itemIds: number[]): Promise<{ text: string; covered: Set<number> }> {
  const covered = new Set<number>();
  if (!itemIds.length) return { text: "", covered };
  const [{ data: items }, { data: motions }, { data: docs }, { data: sections }] = await Promise.all([
    supabase.from("agenda_items").select("id, meeting_id, title, plain_english_summary, meetings(meeting_date)").in("id", itemIds),
    supabase.from("motions").select("id, agenda_item_id, text_content, result, mover, seconder, meta, votes(person_id, vote)").in("agenda_item_id", itemIds),
    supabase.from("extracted_documents").select("agenda_item_id, title, key_facts").in("agenda_item_id", itemIds),
    supabase.from("document_sections").select("agenda_item_id, section_title, section_text, section_order").in("agenda_item_id", itemIds)
      .order("section_order").limit(400),
  ]);
  const has = (id: number) => [motions, docs, sections].some((rows) => ((rows || []) as any[]).some((r) => r.agenda_item_id === id));
  const bare = ((items || []) as any[]).filter((i) => !has(i.id) && i.meeting_id);
  const loose = new Map<number, string[]>();  // meeting → its unattached minutes/report text
  if (bare.length) {
    const { data: meetingDocs } = await supabase.from("documents").select("id, meeting_id")
      .in("meeting_id", [...new Set(bare.map((i) => i.meeting_id))]);
    const docMeeting = new Map(((meetingDocs || []) as any[]).map((d) => [d.id, d.meeting_id]));
    if (docMeeting.size) {
      const { data: free } = await supabase.from("document_sections").select("document_id, section_text")
        .in("document_id", [...docMeeting.keys()]).is("agenda_item_id", null).limit(2000);
      for (const s of (free || []) as any[]) {
        const mid = docMeeting.get(s.document_id);
        if (mid && s.section_text) loose.set(mid, [...(loose.get(mid) || []), s.section_text]);
      }
    }
  }
  const out: string[] = [];
  for (const item of (items || []) as any[]) {
    const meeting = Array.isArray(item.meetings) ? item.meetings[0] : item.meetings;
    const lines = [`ITEM ${item.id} (${meeting?.meeting_date ?? "date unknown"}): ${String(item.title || "").split("\n")[0]}`];
    for (const m of ((motions || []) as any[]).filter((m) => m.agenda_item_id === item.id)) {
      const counts = completeVoteCounts(m);
      const opposed = (m.votes || []).filter((v: any) => v.vote === "No").length;
      lines.push(`  MOTION: ${String(m.text_content || "").slice(0, 1500)} | RESULT: ${m.result || "not recorded"}` +
        `${counts ? ` | VOTE ${counts.yes}–${counts.no}` : opposed ? ` | ${opposed} named as opposed (full vote not recorded)` : ""}` +
        `${m.mover ? ` | moved by ${m.mover}` : ""}${m.seconder ? `, seconded by ${m.seconder}` : ""}`);
    }
    for (const d of ((docs || []) as any[]).filter((d) => d.agenda_item_id === item.id)) {
      const facts = Array.isArray(d.key_facts) ? d.key_facts.slice(0, 12).join("; ") : "";
      if (facts) lines.push(`  REPORT "${d.title}": ${facts}`);
    }
    const text = ((sections || []) as any[]).filter((s) => s.agenda_item_id === item.id)
      .map((s) => `${s.section_title ? `${s.section_title}: ` : ""}${s.section_text || ""}`).join(" ").replace(/\s+/g, " ");
    if (text) lines.push(`  DOCUMENT TEXT: ${text.slice(0, 4000)}`);
    const pattern = !has(item.id) ? subjectPattern(item.title) : null;
    if (pattern) {
      const found = (loose.get(item.meeting_id) || []).map((t) => ({ t, at: t.search(pattern) })).filter((f) => f.at >= 0)
        .map((f) => f.t.slice(f.at, f.at + 3000).replace(/\s+/g, " ")).slice(0, 3);
      for (const f of found) lines.push(`  MINUTES OR REPORT TEXT FROM THIS MEETING: ${f}`);
    }
    if (lines.length > 1) covered.add(item.id);
    else lines.push("  (no minutes, motions or reports found for this item)");
    out.push(lines.join("\n"));
  }
  return { text: out.join("\n\n").slice(0, RECORD_CAP), covered };
}

/** The statements a page makes and the records behind them, for a topic or a meeting page; null for others. */
export async function claimsAndRecords(supabase: SupabaseClient, path: string): Promise<{ claims: Claim[]; records: string } | null> {
  const topic = path.match(/^\/matters\/([^/]+)$/)?.[1];
  const meeting = path.match(/^\/meetings\/([^/]+)$/)?.[1];
  if (topic) {
    const { data: m } = await supabase.from("matters").select("id, plain_english_summary, meta").eq("slug", topic).maybeSingle();
    if (!m) return null;
    const meta = (m.meta || {}) as Record<string, any>;
    const { data: own } = await supabase.from("agenda_items").select("id").eq("matter_id", m.id).limit(60);
    const ids = ((own || []) as any[]).map((i) => i.id);
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
    const { data: items } = await supabase.from("agenda_items").select("id, plain_english_summary").eq("meeting_id", mt.id).limit(80);
    const list = (items || []) as any[];
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
- supported: the records say this (paraphrase is fine; a reasonable plain-language summary of a motion is supported).
- not_in_record: nothing in the records says it (an invented detail, a number or outcome the records don't give).
- contradicted: the records say something different (a different address, count, outcome, date or step).
- cannot_check: the records given are too thin to judge it (only a title, or text that doesn't cover this
  part of the item). Missing records are not a problem with the page: use this, never not_in_record, when the
  records simply don't reach that far.
Judge facts, not style. Quote the record's words in "source" whenever you can.

STATEMENTS
${input.claims.map((c) => `[${c.id}] ${c.text}`).join("\n")}

RECORDS
${input.records}`;
  const result = await getAiClient().json({ stage: "review", prompt, schema: VerifySchema, schemaName: "page_verify" });
  const byId = new Map(input.claims.map((c) => [c.id, c]));
  return result.data.verdicts
    .filter((v) => (v.verdict === "not_in_record" || v.verdict === "contradicted") && byId.has(v.id))
    .map((v) => {
      const claim = byId.get(v.id)!;
      return {
        key: claim.key, problem: "unsupported" as const, verdict: null, fix: v.fix,
        reason: `${v.verdict === "contradicted" ? "Contradicted by the record" : "Not in the record"}: ${v.reason}${v.source ? ` The record says: “${v.source.slice(0, 400)}”` : ""}`,
        excerpt: claim.text,
      };
    });
}
