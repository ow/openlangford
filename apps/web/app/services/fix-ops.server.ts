import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { getAiClient } from "./ai/index.server";
import { updateSource } from "./sources.server";
import type { Source } from "../lib/sources";

/**
 * What the fix agents (topic, meeting and property pages) do the same way, in one place. Each agent keeps its own
 * menu, since a page only offers what its records can back, but an action two pages share (correct a source, give a
 * summary writer an instruction, rewrite a topic step's line) is written once here: its fields, its prompt wording,
 * its checks and its writes. A new action that fits more than one page goes here and is added to each menu.
 */

export const squash = (s: string) => s.replace(/\s+/g, " ").trim();
export const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
export const normal = (s: string) => squash(s).toLowerCase().replace(/[“”]/g, "\"").replace(/[‘’]/g, "'");

/** Whether a quote is in the records (whitespace and quote marks aside). Lines a model wrote (NOTES extracted from a
 * report, the agent's own FOUND findings) don't count: a rewrite must rest on the record's words. */
export function quoteInRecords(quote: string | null | undefined, records: string): boolean {
  const q = normal(quote || "");
  const record = normal(records.split("\n").filter((line) => !/^\s*(NOTES \(|FOUND for )/.test(line)).join("\n"));
  if (q.length < 12) return false;
  if (record.includes(q)) return true;
  // Several passages quoted together ("…" "…", or joined with an ellipsis): each must be in the record.
  const pieces = q.split(/"|\s*(?:…|\.\.\.)\s*/).map((x) => x.trim().replace(/^[\s,;]+|[\s,;]+$/g, "")).filter((x) => x.length >= 12);
  return pieces.length > 0 && pieces.every((x) => record.includes(x));
}

// ---------- Correcting a source (topic and property pages show sources) ----------

/** The plan fields of edit_source, spread into an agent's action schema. */
export const EDIT_SOURCE_FIELDS = {
  source_id: z.number().nullable().describe("edit_source: the id after \"source-\" in the source's key. Otherwise null."),
  new_headline: z.string().nullable().describe("edit_source: the source's corrected headline, one plain line that says only what the source says (under 160 characters). null to leave it."),
  new_quote: z.string().nullable().describe("edit_source: a corrected quote, the source text's own words exactly. null to leave it."),
  new_note: z.string().nullable().describe("edit_source: a corrected staff note (shown to staff, not readers), e.g. the figures that differ between reports. null to leave it."),
  new_date_label: z.string().nullable().describe("edit_source: how the date shows when only a season or month is known (\"Spring 2019\"). null to leave it."),
};

/** The menu entry for edit_source, for an agent's prompt. */
export const EDIT_SOURCE_PROMPT = `- edit_source: a SOURCE says less, or something else, than its headline, quote or note claims (an overstated
  headline, a figure the source doesn't give, a date shown wrongly). key is the flag's source-<id>; give source_id and
  only the fields that change (new_headline, new_quote, new_note, new_date_label), and put the source's own words
  that back the change in "source". A headline says what the source says and who said it, never more. If the sources
  disagree (acreage, a total), say so in new_note or drop the figure from the headline.`;

export type SourceStep = { key: string | null; source: string | null; source_id: number | null; new_headline: string | null; new_quote: string | null;
  new_note: string | null; new_date_label: string | null };
export type SourceEditResult = { ok: true; source: Source; edit: Record<string, string> } | { ok: false; why: string };

/** Check an edit_source step and make the change. `flagged` is whether the page's staff-agreed flags (or a page-level
 * note) cover this source; `records` is what the agent read, and `textOf` each source's saved page text, so the quote
 * the change rests on, and any new quote, are checked against the source's own words. */
export async function editSourceOnPage(supabase: SupabaseClient, step: SourceStep,
  ctx: { sources: Source[]; textOf: Map<number, string>; records: string; flagged: (key: string | null) => boolean }): Promise<SourceEditResult> {
  const src = ctx.sources.find((x) => x.id === step.source_id);
  if (!src) return { ok: false, why: "no such source on this page" };
  if (!ctx.flagged(`source-${src.id}`) || (step.key && step.key !== `source-${src.id}` && !ctx.flagged(step.key))) return { ok: false, why: "that source isn't flagged on this page, so nothing changed" };
  const own = [ctx.textOf.get(src.id) || "", src.quote || "", src.headline].join("\n");
  if (!quoteInRecords(step.source, `${ctx.records}\n${own}`)) return { ok: false, why: "its quote isn't the source's exact words, so the source stays; press Fix again" };
  if (step.new_quote && !quoteInRecords(step.new_quote, own)) return { ok: false, why: "the new quote isn't the source's exact words, so the source stays" };
  const edit: Record<string, string> = {
    ...(step.new_headline ? { headline: squash(step.new_headline).slice(0, 200) } : {}),
    ...(step.new_quote ? { quote: step.new_quote } : {}),
    ...(step.new_note ? { note: squash(step.new_note).slice(0, 600) } : {}),
    ...(step.new_date_label ? { date_label: squash(step.new_date_label).slice(0, 40) } : {}),
  };
  if (!Object.keys(edit).length) return { ok: false, why: "the agent didn't give a new headline, quote, note or date" };
  try { await updateSource(supabase, src.id, edit); } catch { return { ok: false, why: "couldn't save the source" }; }
  return { ok: true, source: src, edit };
}

/** The page's sources with each one's saved page text (never shown, read to check quotes). */
export async function loadSources(supabase: SupabaseClient, sources: Source[]): Promise<{ sources: Source[]; textOf: Map<number, string> }> {
  const unique = [...new Map(sources.map((s) => [s.id, s])).values()];
  if (!unique.length) return { sources: unique, textOf: new Map() };
  const { data } = await supabase.from("sources").select("id, content_text").in("id", unique.map((s) => s.id));
  return { sources: unique, textOf: new Map(((data || []) as any[]).map((r) => [r.id as number, (r.content_text || "") as string])) };
}

// ---------- Rewriting a topic's text (summary and "where it stands") ----------

/** One instruction for the summary writer, with the record words it rests on. null when there's nothing to follow. */
export function summaryInstruction(newText: string | null, quote: string | null): string | null {
  const text = squash(newText || "").slice(0, 500);
  if (!text) return null;
  const q = squash(quote || "");
  return `${text}${q ? ` The record says: “${q.slice(0, 250)}”` : ""}`;
}

/** Keep instructions on the topic (matters.meta.editor_notes), so this rewrite and every later one, here or in the
 * pipeline's matter_summaries, follow them. The last ten are kept. */
export async function saveEditorNotes(supabase: SupabaseClient, matterId: number, notes: string[]): Promise<void> {
  if (!notes.length) return;
  const { data: row } = await supabase.from("matters").select("meta").eq("id", matterId).single();
  const meta = (row?.meta || {}) as Record<string, any>;
  await supabase.from("matters").update({ meta: { ...meta, editor_notes: [...(meta.editor_notes || []), ...notes].slice(-10) } }).eq("id", matterId);
}

/** The note's line when a rewrite was set aside because staff edited that text by hand: the person's version stays, so
 * the instruction was not carried out, and the note says how to use the agent's version instead. */
export function heldByHandLine(label: string, fields: ("title" | "summary" | "status_line")[]): string {
  const what = [fields.includes("summary") ? "summary" : "", fields.includes("status_line") ? "\"where it stands\" line" : ""].filter(Boolean).join(" and ");
  return `The ${what} of ${label} wasn't changed: it was edited by hand, so that version was kept. The agent's version is saved as the automatic one; open the pencil and press Reset to automatic to use it.`;
}

/** The note's line for an instruction the rewritten summary doesn't yet follow. */
export function unfollowedLine(u: { note: string; missing?: string }): string {
  return `The summary was rewritten but doesn't yet say what was asked: "${u.note.split(" The record says:")[0].slice(0, 300)}"${u.missing ? ` Still missing: ${u.missing}` : ""}`;
}

// ---------- Did the text do what the editor asked? ----------

const FollowedSchema = z.object({ checks: z.array(z.object({
  followed: z.boolean().describe("Whether the text now does what this instruction asks. A part of the request the records can't support counts as done when the text leaves that part out and states nothing the records don't."),
  missing: z.string().describe("What the instruction asks for that the text still doesn't do, in one short sentence. Empty when followed."),
})) });

/** Judge whether a rewritten text does what each instruction (an editor's request, or a problem staff agreed on) asks.
 * The fact check only asks whether the text is true, so an accurate rewrite that ignores the request passes it:
 * this is the check that catches that. One verdict per instruction, in order. */
export async function checkFollowed(instructions: string[], text: string, records: string, signal?: AbortSignal): Promise<{ instruction: string; followed: boolean; missing: string }[]> {
  if (!instructions.length) return [];
  const { data } = await getAiClient().json({ stage: "review", signal, schema: FollowedSchema, schemaName: "instruction_check",
    prompt: `An editor of a site that follows a city council asked for changes to a page's text. Judge, for each instruction below,
whether the text now does what it asks (its shape and content, not only whether it is true).

Instructions:
${instructions.map((x, i) => `${i + 1}. ${squash(x)}`).join("\n")}

TEXT:
${text}

RECORDS (what the site can state):
${records.slice(0, 30_000)}

Return one check per instruction, in order.` });
  return instructions.map((instruction, i) => ({ instruction, followed: data.checks[i]?.followed ?? false, missing: data.checks[i]?.missing || "" }));
}

// ---------- Rewriting a topic step's or entry's line ----------

export type EntryLine = { line?: string; heading?: string; source?: string };

/** Write entry text onto a topic. `headlines` are item-id -> line for the topic's own steps (timeline_headlines, and
 * staff_headlines, the copy a summary rewrite keeps); `lines` are key -> line/heading for linked mentions, related
 * topics' entries and report entries (entry_lines, which the page shows instead of the generated text). Merges into
 * what's there. Returns an error message, or null. */
export async function writeEntryText(supabase: SupabaseClient, matterId: number, text: { headlines?: Record<string, string>; lines?: Record<string, EntryLine> }): Promise<string | null> {
  const headlines = text.headlines || {}, lines = text.lines || {};
  if (!Object.keys(headlines).length && !Object.keys(lines).length) return null;
  const { data: matter } = await supabase.from("matters").select("meta").eq("id", matterId).single();
  const meta = (matter?.meta || {}) as Record<string, any>;
  const entryLines = { ...(meta.entry_lines || {}) };
  for (const [key, value] of Object.entries(lines)) entryLines[key] = { ...(entryLines[key] || {}), ...value };
  const { error } = await supabase.from("matters").update({ meta: {
    ...meta,
    timeline_headlines: { ...(meta.timeline_headlines || {}), ...headlines },
    staff_headlines: { ...(meta.staff_headlines || {}), ...headlines },
    ...(Object.keys(lines).length ? { entry_lines: entryLines } : {}),
  } }).eq("id", matterId);
  return error ? error.message : null;
}

// ---------- Rewording a decision's plain-language line ----------

/** The plan field of rewrite_decision, spread into an agent's action schema. */
export const REWRITE_DECISION_FIELDS = {
  decision_id: z.number().int().nullable().describe("rewrite_decision: the decision's id (the number after \"decision-\"). Otherwise null."),
};

/** The menu entry for rewrite_decision, for an agent's prompt. */
export const REWRITE_DECISION_PROMPT = `- rewrite_decision: the "Decision:" line under an entry is wrong (a misspelled street, a wrong figure, a slip the
  minutes made that the rest of the record corrects, or wording that says more than the motion). Give decision_id and
  the new line in new_text: one plain sentence of at most 160 characters saying what Council decided, outcome first.
  Put in "source" the record's own words that back the new line. The motion's own wording (the minutes) is never
  changed: only the plain-language line readers see beside it.`;

export type DecisionLine = { id: number; itemId: number; text: string; summary: string | null };

/** The decisions under the given items, for an agent's prompt ("DECISIONS ON THIS PAGE") and for rewriteDecision. */
export async function decisionLines(supabase: SupabaseClient, itemIds: number[]): Promise<DecisionLine[]> {
  if (!itemIds.length) return [];
  const { data } = await supabase.from("motions").select("id, agenda_item_id, text_content, plain_english_summary").in("agenda_item_id", itemIds).order("id");
  return ((data || []) as any[]).map((m) => ({ id: m.id, itemId: m.agenda_item_id, text: squash(m.text_content || ""), summary: m.plain_english_summary }));
}

/** The prompt block listing the decisions an agent may reword, each under the entry key the page uses for its item. */
export function decisionsBlock(decisions: DecisionLine[], keyOf: (itemId: number) => string | null): string {
  const lines = decisions.map((d) => {
    const key = keyOf(d.itemId);
    return key ? `- decision-${d.id} under [${key}]: "Decision: ${squash(d.summary || "") || "(no plain line; the page shows the motion)"}"\n  motion: ${d.text.slice(0, 400)}` : "";
  }).filter(Boolean);
  return lines.length ? `DECISIONS ON THIS PAGE (rewrite_decision by id):\n${lines.join("\n")}` : "";
}

/** Check a rewrite_decision step and make the change: motions.plain_english_summary, marked as a person's
 * (motions.meta.manual.summary, see pipeline/ingestion/manual_edits.py) so a re-ingest or a motion-summary run keeps
 * it and stores its own as `auto`. Only a decision listed for the page, and only on the record's words. */
export async function rewriteDecision(supabase: SupabaseClient, step: { decision_id: number | null; new_text: string | null; source: string | null },
  ctx: { decisions: DecisionLine[]; records: string; by: string }): Promise<{ ok: true; decision: DecisionLine; text: string } | { ok: false; why: string }> {
  const decision = ctx.decisions.find((d) => d.id === step.decision_id);
  if (!decision) return { ok: false, why: "that decision isn't on this page, so nothing changed" };
  const text = squash(step.new_text || "");
  if (text.length < 15 || text.length > 200) return { ok: false, why: "the new line wasn't usable, so nothing changed" };
  if (!quoteInRecords(step.source, `${ctx.records}\n${decision.text}`)) return { ok: false, why: "its quote isn't the record's exact words, so the decision line stays" };
  const { data: row } = await supabase.from("motions").select("meta, plain_english_summary").eq("id", decision.id).single();
  const meta = (row?.meta || {}) as Record<string, any>;
  const manual = { ...(meta.manual || {}) };
  manual.summary = { by: ctx.by, at: new Date().toISOString(), auto: manual.summary?.auto ?? row?.plain_english_summary ?? null, source: squash(step.source || "").slice(0, 400) };
  const { error } = await supabase.from("motions").update({ plain_english_summary: text, meta: { ...meta, manual } }).eq("id", decision.id);
  if (error) return { ok: false, why: "couldn't save the decision line" };
  decision.summary = text;
  return { ok: true, decision, text };
}

// ---------- Taking a wrong address off a topic ----------

/** The plan field of unlink_address, spread into an agent's action schema. */
export const UNLINK_ADDRESS_FIELDS = {
  property_id: z.number().int().nullable().describe("unlink_address: the address's id (the number after \"address-\"). Otherwise null."),
};

/** The menu entry for unlink_address, for an agent's prompt. */
export const UNLINK_ADDRESS_PROMPT = `- unlink_address: an address mapped to this topic (listed under ADDRESSES MAPPED TO THIS TOPIC) isn't where it
  happens: a misspelled street the rest of the record corrects ("Atkins Rd" for "Atkins Avenue"), a neighbouring lot
  named only in passing, or a place the topic is not about. Give property_id and in "source" the record's words that
  show the right address. The address stays on the site; it just stops being linked to this topic (and the map pin
  and "at this address" link go). Never unlink the only address the records support.`;

export type MappedAddress = { id: number; address: string; slug: string; itemIds: number[] };

/** The addresses a topic is linked to (its own link and its items'), as its page maps them. */
export async function mappedAddresses(supabase: SupabaseClient, matterId: number): Promise<MappedAddress[]> {
  const { data } = await supabase.from("property_links").select("property_id, agenda_item_id, properties!inner(address, slug, hidden)")
    .eq("matter_id", matterId).eq("hidden", false).eq("properties.hidden", false);
  const out = new Map<number, MappedAddress>();
  for (const r of (data || []) as any[]) {
    const p = Array.isArray(r.properties) ? r.properties[0] : r.properties;
    const a = out.get(r.property_id) ?? { id: r.property_id, address: p?.address || "", slug: p?.slug || "", itemIds: [] as number[] };
    if (r.agenda_item_id && !a.itemIds.includes(r.agenda_item_id)) a.itemIds.push(r.agenda_item_id);
    out.set(r.property_id, a);
  }
  return [...out.values()];
}

/** The prompt block listing a topic's addresses. */
export function addressesBlock(addresses: MappedAddress[]): string {
  return addresses.length ? `ADDRESSES MAPPED TO THIS TOPIC (unlink_address by id):\n${addresses.map((a) =>
    `- address-${a.id}: ${a.address}${a.itemIds.length ? ` (from item${a.itemIds.length === 1 ? "" : "s"} ${a.itemIds.join(", ")})` : ""}`).join("\n")}` : "";
}

/** Check an unlink_address step and hide that address's links to the topic (property_links.hidden, which the
 * pipeline's properties stage keeps). It refuses to take off the topic's last address. */
export async function unlinkAddress(supabase: SupabaseClient, matterId: number, step: { property_id: number | null; source: string | null },
  ctx: { addresses: MappedAddress[]; records: string }): Promise<{ ok: true; address: MappedAddress } | { ok: false; why: string }> {
  const address = ctx.addresses.find((a) => a.id === step.property_id);
  if (!address) return { ok: false, why: "that address isn't mapped to this topic, so nothing changed" };
  if (ctx.addresses.length < 2) return { ok: false, why: "it's the topic's only address, so it stays" };
  if (!quoteInRecords(step.source, ctx.records)) return { ok: false, why: "its quote isn't the record's exact words, so the address stays" };
  const { error } = await supabase.from("property_links").update({ hidden: true }).eq("property_id", address.id).eq("matter_id", matterId);
  if (error) return { ok: false, why: "couldn't unlink the address" };
  ctx.addresses.splice(ctx.addresses.indexOf(address), 1);
  return { ok: true, address };
}
