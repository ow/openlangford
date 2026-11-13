import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchAll } from "./page-verify.server";

/**
 * The fix agent's add_motion: a decision the minutes record but the item lacks. The commonest cause is a scanned
 * copy of the minutes placing an outcome ("CARRIED.") under the item before it, so ingest held the motion back as
 * unverified (agenda_items.meta.unverified_motion_proposals). The agent never writes a decision from its own reading:
 * its quote must appear word for word in a section of that meeting's minutes or reports, and must itself contain the
 * motion and the outcome. An outcome that sits only in the neighbouring section doesn't count.
 */

/** The results stored on motions. A motion to table or refer is a carried motion whose disposition says so. */
export const MOTION_RESULTS = ["CARRIED", "DEFEATED", "WITHDRAWN"] as const;
export type MotionResult = (typeof MOTION_RESULTS)[number];

const OUTCOME_WORDS: Record<MotionResult, RegExp> = {
  CARRIED: /\b(carried|passed|approved)\b/,
  DEFEATED: /\b(defeated|lost|failed)\b/,
  WITHDRAWN: /\bwithdrawn\b/,
};

/** Compared without case, markup, spacing or OCR artefacts (soft hyphens, words broken across lines, curly quotes,
 * dashes, non-breaking spaces): the model quotes the clean version of a scanned page. */
export function normalise(text: string): string {
  return text.normalize("NFKC").toLowerCase()
    .replace(/\u00ad/g, "")
    .replace(/(\w)-\s*\n\s*(\w)/g, "$1$2")
    .replace(/[*_`#>“”„"‘’‚']/g, "")
    .replace(/[‐‑‒–—―]/g, "-")
    .replace(/[\s\u00a0\u202f]+/g, " ").trim();
}

/** How the motion is filed: a motion to table or refer is a carried motion with that disposition. */
export function dispositionOf(text: string): string {
  return /\btable\b/i.test(text) ? "Tabled" : /\brefer(red)?\b/i.test(text) ? "Referred" : "Substantive";
}

export type MotionProposal = { item_key: string; motion_text: string; result: MotionResult; mover: string | null; seconder: string | null; quote: string };

/** Why a quote can't back the motion, or null when it can. Pure, so it can be tested on its own. */
export function quoteProblem(p: Pick<MotionProposal, "motion_text" | "result" | "quote">, sectionTexts: string[]): string | null {
  const quote = normalise(p.quote);
  const motion = normalise(p.motion_text);
  if (motion.length < 10) return "the motion's wording is missing";
  if (!quote.includes(motion)) return "the quote doesn't contain the motion's wording";
  if (!OUTCOME_WORDS[p.result].test(quote)) return `the quote doesn't say the motion was ${p.result.toLowerCase()}`;
  if (!sectionTexts.some((t) => normalise(t).includes(quote))) return "the quote isn't in this meeting's minutes or reports, word for word";
  return null;
}

export async function addMotion(supabase: SupabaseClient, itemId: number, p: MotionProposal, requester: { id: string }) {
  const { data: item } = await supabase.from("agenda_items").select("id, meeting_id, matter_id, item_order, meta").eq("id", itemId).maybeSingle();
  if (!item?.meeting_id) throw new Error("that item couldn't be found");
  // The same motion may already exist under the item before (the scanned copy's misfiling): moving it is the fix.
  const { data: existing } = await supabase.from("motions").select("id, agenda_item_id, text_content").eq("meeting_id", item.meeting_id);
  const twin = (existing || []).find((m: any) => normalise(m.text_content || "") === normalise(p.motion_text));
  if (twin) throw new Error(twin.agenda_item_id === itemId ? "the item already has that motion"
    : `that motion is already recorded under item ${twin.agenda_item_id} at the same meeting (motion ${twin.id}), so it stays there; if this entry is that item's heading, repoint_mention it to item ${twin.agenda_item_id}, and if the motion sits under the unfiled container, move_motion it`);
  // Every section of the meeting's minutes and reports: those of its documents, and those attached to its items.
  const [{ data: docs }, { data: items }] = await Promise.all([
    supabase.from("documents").select("id").eq("meeting_id", item.meeting_id),
    supabase.from("agenda_items").select("id").eq("meeting_id", item.meeting_id),
  ]);
  const docIds = (docs || []).map((d: any) => d.id);
  const itemIds = (items || []).map((i: any) => i.id);
  const sections = [
    ...(docIds.length ? await fetchAll<any>((from, to) => supabase.from("document_sections").select("id, document_id, extracted_document_id, section_text")
      .in("document_id", docIds).order("id").range(from, to)) : []),
    ...(itemIds.length ? await fetchAll<any>((from, to) => supabase.from("document_sections").select("id, document_id, extracted_document_id, section_text")
      .in("agenda_item_id", itemIds).order("id").range(from, to)) : []),
  ];
  const problem = quoteProblem(p, sections.map((s) => s.section_text || ""));
  if (problem) throw new Error(problem);
  const quote = normalise(p.quote);
  const source = sections.find((s) => normalise(s.section_text || "").includes(quote))!;

  // A name counts only when the quote has it. Its person is linked only when exactly one of the meeting's attendees has
  // that surname ("Councillor Wade"); otherwise the name is kept as the minutes give it, unlinked.
  const { data: attendees } = await supabase.from("attendance").select("person_id, people(name)").eq("meeting_id", item.meeting_id);
  const person = (name: string | null) => {
    const surname = normalise(name || "").split(" ").pop();
    if (!name?.trim() || !surname || !quote.includes(surname)) return { name: null, id: null };
    const hits = ((attendees || []) as any[]).filter((a) => normalise(a.people?.name || "").split(" ").pop() === surname);
    return { name: name.trim(), id: hits.length === 1 ? hits[0].person_id : null };
  };
  const [mover, seconder] = [person(p.mover), person(p.seconder)];
  const at = new Date().toISOString();
  const { data: motion, error } = await supabase.from("motions").insert({
    meeting_id: item.meeting_id, agenda_item_id: itemId, text_content: p.motion_text.trim(), result: p.result,
    disposition: dispositionOf(p.motion_text),
    mover: mover.name, seconder: seconder.name, mover_id: mover.id, seconder_id: seconder.id,
    meta: {
      placed_by: { method: "fix_agent", item_order: item.item_order },
      vote_record: { source: "bounded_official_minutes", coverage: "not_recorded", outcome_status: "verified", outcome_source_quote: p.quote.slice(0, 500) },
      individual_vote_coverage: "not_recorded",
      staff_verified: { at, by: requester.id, via: "fix_agent", section_id: source.id, document_id: source.document_id,
        extracted_document_id: source.extracted_document_id, quote: p.quote.slice(0, 1000) },
    },
  }).select("id").single();
  if (error || !motion) throw new Error(error?.message || "the motion couldn't be saved");

  // The held-back copy of this motion, if ingest kept one, is marked settled (kept, so the scan's history stays and a
  // re-run of motion extraction doesn't propose it again).
  const meta = (item.meta || {}) as Record<string, any>;
  const held = (meta.unverified_motion_proposals || []) as any[];
  if (held.some((h) => normalise(h.motion_text || "") === normalise(p.motion_text))) {
    await supabase.from("agenda_items").update({ meta: { ...meta, unverified_motion_proposals: held.map((h) =>
      normalise(h.motion_text || "") === normalise(p.motion_text) ? { ...h, resolved_motion_id: motion.id, resolved_by: requester.id, resolved_at: at } : h) } })
      .eq("id", itemId);
  }
  return { motionId: motion.id as number, meetingId: item.meeting_id as number, matterId: item.matter_id as number | null,
    documentId: (source.extracted_document_id ?? source.document_id) as number | null };
}

/** Words a title shares with most others, no use for telling items apart. */
const COMMON = new Set(["application", "amendment", "amend", "bylaw", "council", "report", "staff", "consideration", "agreement",
  "request", "approval", "approve", "regarding", "district", "development", "official", "recorded", "motions", "langford", "meeting",
  "proposed", "property", "properties", "zoning", "designation", "allow", "approximately", "number", "within"]);

/** Why a motion filed under no item can't be moved onto this item, or null when it can: the motion has to name what
 * the item is about. A number in the title (an address, a bylaw, a file) must appear in the motion; failing numbers,
 * two of the title's distinctive words must. Pure, so it can be tested on its own. */
export function moveProblem(itemTitle: string, motionText: string): string | null {
  const title = normalise(itemTitle);
  const motion = normalise(motionText);
  if (motion.length < 10) return "the motion's wording is missing";
  const numbers = [...new Set(title.match(/\b\d{3,}\b/g) || [])];
  if (numbers.length) {
    return numbers.some((n) => new RegExp(`\\b${n}\\b`).test(motion)) ? null
      : `the motion doesn't mention the item's number (${numbers.join(", ")})`;
  }
  const words = [...new Set(title.split(/[^a-z]+/).filter((w) => w.length >= 5 && !COMMON.has(w)))];
  const hits = words.filter((w) => motion.includes(w));
  if (words.length && hits.length >= Math.min(2, words.length)) return null;
  return "the motion's wording doesn't name what the item is about";
}

/**
 * The fix agent's move_motion: a decision the history catch-up filed under the meeting's "Official recorded motions"
 * container (it couldn't tell which item the motion decided) moved onto the item it is about. Only motions in that
 * container move, only within their meeting, and only when the motion names the item (moveProblem).
 */
export async function moveMotion(supabase: SupabaseClient, itemId: number, motionId: number, requester: { id: string }, reason: string) {
  const [{ data: item }, { data: motion }] = await Promise.all([
    supabase.from("agenda_items").select("id, meeting_id, matter_id, item_order, title").eq("id", itemId).maybeSingle(),
    supabase.from("motions").select("id, meeting_id, agenda_item_id, text_content, result, meta").eq("id", motionId).maybeSingle(),
  ]);
  if (!item?.meeting_id) throw new Error("that item couldn't be found");
  if (!motion) throw new Error(`motion ${motionId} couldn't be found`);
  if (motion.meeting_id !== item.meeting_id) throw new Error("that motion is from a different meeting");
  if (motion.agenda_item_id === itemId) throw new Error("the item already has that motion");
  const { data: from } = await supabase.from("agenda_items").select("id, title, item_order").eq("id", motion.agenda_item_id).maybeSingle();
  const container = !!from && (from.item_order === "official-recorded-motions" || /^official recorded motions/i.test(from.title || ""));
  if (!container) throw new Error(`that motion is filed under another item at the meeting ("${(from?.title || "").slice(0, 80)}"), not the unfiled container; moving it needs a person`);
  const problem = moveProblem(item.title || "", motion.text_content || "");
  if (problem) throw new Error(problem);
  const at = new Date().toISOString();
  const previous = (motion.meta || {}) as Record<string, any>;
  const meta = { ...previous, placed_before: previous.placed_by ?? null,
    placed_by: { method: "fix_agent_move", item_order: item.item_order, from_item_id: from!.id, by: requester.id, at, reason: reason.slice(0, 300) } };
  const { error } = await supabase.from("motions").update({ agenda_item_id: itemId, meta }).eq("id", motionId);
  if (error) throw new Error(error.message);
  return { motionId, meetingId: item.meeting_id as number, matterId: item.matter_id as number | null, fromItemId: from!.id as number,
    text: String(motion.text_content || ""), result: String(motion.result || "") };
}
