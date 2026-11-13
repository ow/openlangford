import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { getAiClient } from "./ai/index.server";
import { renderPage } from "../lib/page-render.server";
import { FLAG_PROBLEM_LABELS, entryLabel, keepStaffRatings, type PageFlag } from "../lib/page-review-types";
import { judgeTopics, readPage, type TopicVerdict } from "./page-check.server";
import { INTERACTIVE_JOB_PRIORITY, decideSuggestion, headingChildren, isHeadingOrder, listSuggestions, matterForPath, removableKey, removeEntry, repointMention, setTopicHidden, type Suggestion } from "./page-links.server";
import { fetchAll, itemRecords, recheckClaims, sentences, topicItemIds, type Claim } from "./page-verify.server";
import { bylawRecords } from "./bylaw-records.server";
import { sourceRecordLines, sourcesFor } from "./sources.server";
import { EDIT_SOURCE_FIELDS, EDIT_SOURCE_PROMPT, MERGE_ADDRESS_FIELDS, MERGE_ADDRESS_PROMPT, REWRITE_DECISION_FIELDS, REWRITE_DECISION_PROMPT, UNLINK_ADDRESS_FIELDS, UNLINK_ADDRESS_PROMPT, addressesBlock, capital,
  decisionLines, decisionsBlock, editSourceOnPage, quoteInRecords, heldByHandLine, loadSources, mappedAddresses, mergeAddress, rewriteDecision, saveEditorNotes, summaryInstruction, unfollowedLine,
  unlinkAddress, writeEntryText } from "./fix-ops.server";
import { findingText, investigate, investigatedRecords, investigationLine, needsInvestigation, type Investigation } from "./fix-investigation.server";
import { applyRecheck, recheckSummary, flagLabel, type RecheckVerdicts } from "../lib/page-recheck";
import { sameSiteTopics } from "./properties";
import { logStaffAction } from "./staff.server";
import { rewriteSummaries } from "./topic-summaries.server";
import { mergeFlat, moveItem, refreshMeetingLifecycles } from "./topic-moves.server";
import type { StaffRole } from "../lib/auth.server";
import { MOTION_RESULTS, addMotion, moveMotion } from "./motion-add.server";
import { fixMeetingPage } from "./meeting-fix.server";
import { fixPropertyPage } from "./property-fix.server";
import { STAGE_LABELS, type StageChoice } from "../components/matter/timeline-step";

/**
 * The fix agent. Marking a page "needs work" starts it on the server: it reads the flags staff agreed with (👍)
 * and their note, plans fixes from a fixed menu, carries them out, and leaves the page "fixed" for staff to
 * confirm, with a note of what it changed and what it couldn't do. Every change is recorded in staff_actions under
 * the person who asked, tagged as the agent's.
 *
 * It reads the same records the page check uses (each item's motions, reports and minutes, including minutes and
 * reports older imports left unattached in the same meeting). It can remove a timeline entry found for the topic or
 * unlink the related topic an entry came from (here, at once); rewrite any entry's line or heading (an item filed here:
 * matters.meta.timeline_headlines, kept through summary rewrites as meta.staff_headlines; a linked mention, related
 * topic's entry or annual report entry: meta.entry_lines, which the page shows instead of the generated text); move a
 * linked mention to the topic it belongs to; and move an item filed under the wrong topic to the right one, or re-file
 * it the way ingest would when no listed topic fits (the one step left to a fix_page job on the pipeline's quick
 * worker). It then rewrites the summaries of the topics whose timelines changed (services/topic-summaries.server.ts)
 * and checks that each summary instruction was followed, all in the same request.
 * Every rewrite carries the record's words it rests on.
 *
 * Before it plans, it investigates: for every agreed flag and the editor's note it searches and reads the City's
 * records itself (fix-investigation.server.ts), and plans from what it found. When it files here an item that another
 * topic holds, it compares the two topics' records itself (judgeTopics, the page check's Related topics judgement) and
 * merges them when they are one project, or keeps the entry as a mention and says why.
 */

/** One sentence of a reason or finding for the note, cut at a sentence end where it runs long. */
const brief = (text: string, max: number) => {
  const t = (text || "").replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("; "));
  return end > max / 2 ? cut.slice(0, end + 1) : `${cut.replace(/\s+\S*$/, "")}…`;
};

const PlanSchema = z.object({
  actions: z.array(z.object({
    action: z.enum(["remove_entry", "move_item", "unfile_item", "file_here", "hide_duplicate", "rewrite_entry", "rewrite_heading",
      "rewrite_summary", "edit_source", "merge_topic", "unlink_related", "accept_suggestion", "move_documents", "hide_page", "add_motion", "move_motion", "set_stage", "rewrite_decision", "unlink_address", "merge_address", "repoint_mention", "no_change", "cannot_fix"]),
    key: z.string().nullable().describe("The entry's key exactly as given, or null."),
    keep_key: z.string().nullable().describe("hide_duplicate: the key of the entry that stays (it already says what this one says). Otherwise null."),
    to_matter_id: z.number().int().nullable().describe("move_item: a candidate topic's id, or null to have it re-filed the way new meetings are filed (never back here). merge_topic: the duplicate topic's id. unlink_related: the related topic's id. Otherwise null."),
    other_matter_id: z.number().int().nullable().describe("merge_topic only, when two related topics below duplicate each other but not this page: the second one's id (to_matter_id is the first). Otherwise null."),
    document_ids: z.array(z.number().int()).nullable().describe("move_documents: the ids (doc-<id>) of the documents attached to the entry that belong to another item. Otherwise null."),
    to_item_id: z.number().int().nullable().describe("move_documents: the id of the item at the same meeting they belong to, from the list given. repoint_mention: the id of the item under the heading that this topic is about. Otherwise null."),
    new_text: z.string().nullable().describe("rewrite_entry: the entry's new one-line description for this topic. rewrite_heading: the entry's new heading. rewrite_summary: the instruction for the summary writer. rewrite_decision: the decision's new plain line. Otherwise null."),
    source: z.string().nullable().describe("add_motion: the minutes passage word for word, from the motion through its outcome (\"That Council adopt Bylaw No. 1239. Carried.\"). set_stage, unlink_address, merge_address, and where the action rewrites text (rewrite_summary, rewrite_entry, rewrite_heading, rewrite_decision): the record's own words that support the new text, quoted exactly, at most 250 characters: the one sentence or clause that says it, never a whole passage. The summary writer only sees the topic's timeline, so without this quote it can't follow the instruction. Null for every other action."),
    ...EDIT_SOURCE_FIELDS,
    ...REWRITE_DECISION_FIELDS,
    ...UNLINK_ADDRESS_FIELDS,
    ...MERGE_ADDRESS_FIELDS,
    motion_id: z.number().int().nullable().describe("move_motion: the MOTION id from the list of decisions filed under no item. Otherwise null."),
    motion_text: z.string().nullable().describe("add_motion: the motion's wording exactly as the minutes give it (\"That Council adopt Bylaw No. 1239.\"). Otherwise null."),
    motion_result: z.enum(MOTION_RESULTS).nullable().describe("add_motion: the outcome the minutes record. Otherwise null."),
    mover: z.string().nullable().describe("add_motion: who moved it, as the minutes name them, or null."),
    seconder: z.string().nullable().describe("add_motion: who seconded it, as the minutes name them, or null."),
    stage: z.enum([...Object.keys(STAGE_LABELS), "none"] as unknown as [StageChoice, ...StageChoice[]]).nullable().describe("set_stage: the step's stage, or none when it is no bylaw stage at all. Otherwise null."),
    reason: z.string().describe("One short sentence a resident would understand (under 30 words): what you're doing and why, or why it can't be done."),
  })),
});

type Candidate = { id: number; title: string; dates: string; related?: boolean; sameSite?: boolean;
  /** Holds an entry staff accepted for this page (a found entry, or a mention staff kept). */
  owner?: boolean };

/** Topics an item filed (or linked) here might belong to instead, not this topic: ones with the same permit or bylaw
 * number, ones holding other items at the same address, and full-text matches on its title. */
async function candidatesFor(supabase: SupabaseClient, matterId: number, item: { title: string; related_address?: unknown }): Promise<Candidate[]> {
  const title = item.title.split("\n")[0];
  const ids = new Map<number, number>();  // topic id -> rank (lower is stronger)
  const numbers = [...new Set(title.match(/\b(?:DVP|TUP|DP|Z|REZ|OCP)[- ]?\d{2}-?\d{2,4}\b|\bBylaw No\.? ?\d{3,4}\b/gi) || [])];
  for (const n of numbers.slice(0, 3)) {
    const digits = n.replace(/^\D+/, "");
    const { data } = await supabase.from("matters").select("id").ilike("identifier", `%${digits}%`).neq("id", matterId).limit(4);
    for (const m of (data || []) as any[]) if (!ids.has(m.id)) ids.set(m.id, 0);
  }
  let addresses: string[] = [];
  try {
    const raw = typeof item.related_address === "string" ? JSON.parse(item.related_address) : item.related_address;
    addresses = (Array.isArray(raw) ? raw : []).filter((a: unknown) => typeof a === "string" && /^\d/.test(a)).slice(0, 3);
  } catch { /* no addresses */ }
  for (const address of addresses) {
    const { data } = await supabase.from("agenda_items").select("matter_id").contains("related_address", JSON.stringify([address]))
      .not("matter_id", "is", null).neq("matter_id", matterId).limit(6);
    for (const r of (data || []) as any[]) if (!ids.has(r.matter_id)) ids.set(r.matter_id, 1);
  }
  const words = title.replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter((w) => w.length > 3).slice(0, 8).join(" or ");
  if (words) {
    const { data } = await supabase.from("matters").select("id").textSearch("text_search", words, { type: "websearch", config: "english" })
      .neq("id", matterId).limit(6);
    for (const m of (data || []) as any[]) if (!ids.has(m.id)) ids.set(m.id, 2);
  }
  if (!ids.size) return [];
  const { data } = await supabase.from("matters").select("id, title, meta, first_seen, last_seen").in("id", [...ids.keys()])
    .is("merged_into", null).is("meta->>hidden", null);
  return ((data || []) as any[]).sort((a, b) => (ids.get(a.id)! - ids.get(b.id)!)).slice(0, 8).map((m) => ({
    id: m.id, title: m.meta?.display_title || m.title, dates: [m.first_seen, m.last_seen].filter(Boolean).join(" to "),
  }));
}

/** A search suggestion's key for the agent: "suggestion-L12" (a meeting item or topic link) or "suggestion-R7" (a report page). */
const suggestionKey = (s: Suggestion) => `suggestion-${s.table === "matter_links" ? "L" : "R"}${s.id}`;

/** Each flagged supporting record in full, with the places it names this topic (title or aliases) marked »so«, so the
 * agent can reword the entry from the record itself rather than from the page's short quote. */
async function evidenceRecords(supabase: SupabaseClient, matterId: number, ids: number[]) {
  if (!ids.length) return "";
  const [{ data: m }, { data: rows }] = await Promise.all([
    supabase.from("matters").select("title, meta").eq("id", matterId).single(),
    supabase.from("matter_evidence").select("id, document_sections(section_title, section_text, documents(title))").in("id", ids),
  ]);
  const meta = (m?.meta || {}) as Record<string, any>;
  const terms = [m?.title, meta.display_title, ...(Array.isArray(meta.aliases) ? meta.aliases : [])]
    .filter((t): t is string => typeof t === "string" && t.length >= 4).map((t) => t.toLowerCase());
  return ((rows || []) as any[]).map((r) => {
    const section = Array.isArray(r.document_sections) ? r.document_sections[0] : r.document_sections;
    const text = String(section?.section_text || "").replace(/\s+/g, " ").trim();
    const lower = text.toLowerCase();
    const hits = terms.filter((t) => lower.includes(t));
    // The whole record, with the places it names this topic marked, so the agent reads it rather than a window of it.
    const passages = hits.length ? text.replace(new RegExp(terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "gi"), (w) => `»${w}«`) : text;
    const title = section?.section_title || section?.documents?.title || "record";
    return `SUPPORTING RECORD evidence-${r.id} (${title}${hits.length ? "" : "; doesn't name this topic"}):\n  ${passages}`;
  }).join("\n\n");
}

/** Whether a suggestion the plan names is already on the page: added in this run, or accepted earlier. */
async function suggestionOnPage(supabase: SupabaseClient, key: string | null | undefined, added: Set<string>) {
  if (!key) return false;
  if (added.has(key)) return true;
  const m = key.match(/^suggestion-([LR])(\d+)$/);
  if (!m) return false;
  const { data } = await supabase.from(m[1] === "L" ? "matter_links" : "matter_report_mentions")
    .select("id").eq("id", Number(m[2])).eq("hidden", false).eq("review", "accepted").maybeSingle();
  return !!data;
}

export function planPrompt(heading: string, entries: { key: string; text: string }[], flags: PageFlag[], note: string | null,
  candidates: Map<string, Candidate[]>, records: string, lookalikes: Candidate[] = [], suggestions: Suggestion[] = [],
  internalNote: string | null = null, attachments = "", findings: (string | undefined)[] = [], noteFinding = "") {
  const removable = entries.filter((e) => removableKey(e.key)).map((e) => e.key);
  const movable = [...candidates.entries()].map(([key, list]) =>
    `- [${key}] could move to: ${list.length ? list.map((c) => `${c.id} "${c.title}"${c.dates ? ` (${c.dates})` : ""}`).join("; ") : "no listed topic (move_item with null re-files it)"}`).join("\n");
  return `You fix problems on a page of Open Langford, a site that follows Langford City council. An editor
reviewed the page "${heading}" and agreed these problems are real:
${flags.map((f, i) => `- [${f.key ?? "whole page"}] ${FLAG_PROBLEM_LABELS[f.problem]}: ${f.reason}${f.fix ? `\n  Approved fix (do this): ${f.fix}` : ""}${f.note ? `\n  Editor's instruction for this entry (follow it, over the fix above): ${f.note}` : ""}${f.recheck && !f.recheck.holds ? `\n  An earlier fix didn't hold when checked against the records: ${f.recheck.reason ?? ""} Keep the record's own wording for that point.` : ""}${findings[i] ? `\n  What you found in the City's records: ${findings[i]}` : ""}`).join("\n")}
${note ? `\nTheir note: ${note}\n${noteFinding ? `  What you found in the City's records: ${noteFinding}\n` : ""}` : ""}${internalNote ? `\nStaff's internal note on this page (background to keep in mind, not an instruction): ${internalNote}\n` : ""}
Before planning you searched and read the City's records for each problem ("What you found" above; the records it
rests on are among the records below). Act on what you found: it is the record's own words, not a guess.

What you can do:
- remove_entry: drop a link found for this topic (${removable.join(", ") || "none here"}). A "background-" entry is
  borrowed from a related topic and already lives on its own topic: remove_entry takes just that entry off this page
  (the related topic stays linked, with its other entries). So a flag saying a background entry belongs to another
  topic, or should "move" there, is fixed with remove_entry. Use unlink_related only when the whole related topic
  doesn't belong here; prefer rewrite_entry or rewrite_heading when only an entry's wording is wrong.
- move_item: an item filed under this topic ("agenda-") or a linked mention ("mention-") that belongs to another topic.
  Pick a listed candidate when it clearly fits; otherwise to_matter_id null, and it is re-filed the way new meetings
  are filed (onto the topic for its own address or permit, or a new one), never back here.
- unfile_item: only for an "agenda-" item that isn't a topic of its own at all (a section heading, a one-off courtesy item).
${movable || "(No flagged items to move.)"}
- hide_duplicate: an "agenda-" entry that repeats another entry on this page (the same step recorded twice, e.g. a staff
  report and the bylaw readings at one meeting): give keep_key, the entry that stays. It is hidden from the timeline,
  not deleted, and stays part of the topic.
- file_here: a "mention-" entry that is really one of this topic's own steps (e.g. the bylaw's adoption shown only as
  "Discussed in another item"). It becomes part of this topic's own history, so the summary can rely on it. If the item
  is filed on another topic, give file_here all the same: you will then compare both topics' records and merge that
  topic into this one when it is the same project, or keep the entry as a mention and say why. Use merge_topic
  directly when the records below already show it (a topic marked "holds an entry staff accepted" has its records below).
- rewrite_entry: a new line for any entry ("agenda-", "mention-", "background-", "report-", "evidence-"): one plain sentence of at most
  140 characters saying what this step did for this topic, outcome first ("Council gave second and third reading to the
  rezoning for the 165-home Costin Avenue apartments"). Use only facts in the records below; no file numbers, bylaw
  numbers or jargon unless the record gives nothing else.
- rewrite_heading: a new heading for a "mention-", "background-", "report-" or "evidence-" entry whose heading is wrong or misleading.
- SOURCE lines are from outside Council's record (the City's own publication, or a news report; the line says who). They
  back only text that carries that attribution ("Victoria News reported…", "the City said in a news release…"); never
  restate one as Council's own decision.
- "evidence-" entries are supporting records: a page of a report, budget or presentation that names this topic. Their
  text is in the records below (the passages that name the topic). When the record says something about this topic,
  rewrite_entry with what it says; when it only lists the topic in passing (a venue in a list, a facility among many),
  remove_entry.
${EDIT_SOURCE_PROMPT}
- rewrite_summary: for the topic's summary or "where it stands", a short instruction for the summary writer in new_text.
  The summary writer treats only items filed on this topic as its history: it will not state a decision (an adoption,
  an approval) that appears here only as a "mention-" entry. When the fix rests on such a decision, first make it part
  of the right history: file_here if the item is on no topic; merge_topic if the topic holding it is this same
  project; or, if that topic is a separate project this page has wrongly taken steps from, move_item those steps of
  this topic's own to it (with to_matter_id null, they are re-filed with the rest of their bylaw).
- merge_topic: when a related or same-named topic below is the very same project as this page (a duplicate, or another
  part of the same thing, like one year's budget split across several topics), with its id; one action per topic.
  When two related topics duplicate each other but are not this page's project, give both: to_matter_id and
  other_matter_id.
- unlink_related: take a topic listed under Related topics off this page when its records (given below as "RELATED
  TOPIC") show it isn't the same place or project (to_matter_id: its id). Its entries leave the timeline with it. If it is the very same project, merge_topic instead.
  A "related-<id>" entry is a topic listed under Related topics: unlink_related or merge_topic it with to_matter_id <id>
  (or no_change when its records show it belongs).
- Another application for the same site (marked below): the same land often comes back years later, a rezoning and
  then a second rezoning or a variance. Those are separate topics, each with its own steps. Steps of the other
  application come off this page (remove_entry, or move_item to it), but never unlink_related or merge_topic it for
  being a different application: the link is how readers find the earlier or later one. Unlink it only when its
  records show it isn't the same land at all.
- no_change: when the editor asks a question ("is this relevant?", "should this be here?") and the answer is that the
  page is right as it is. Answer it in "reason": one plain sentence saying why, from the records (e.g. "The
  2018 item renewed the same five-year access agreement Council granted in 2013, so it belongs here"). Use it too when
  an agreed problem turns out not to be one. Give the key of the entry it's about, or null for the whole page.
- accept_suggestion: add one of the entries the search found for this page (listed below, not yet on it) when it
  supplies what an agreed problem says is missing (e.g. the adoption or decision the status lacks), with its key.
  A meeting item accepted here appears as "Discussed in another item"; if it is this topic's own step, the summary still won't
  rely on it, so say so in the reason and the editor can file it here.
${suggestions.length ? `Entries the search found, waiting for a decision:\n${suggestions.map((x) => `- [${suggestionKey(x)}] ${x.date ?? ""} ${x.title}${x.quote ? `: "${x.quote}"` : ""}${x.reason ? ` (found because: ${x.reason})` : ""}`).join("\n")}\n` : ""}${lookalikes.length ? `Related and same-named topics (those marked "listed under Related topics" show on this page):\n${lookalikes.map((c) => `- ${c.id} "${c.title}"${c.dates ? ` (${c.dates})` : ""}${c.related ? " [listed under Related topics; its records are below]" : ""}${c.owner ? " [holds an entry staff accepted for this page; its records are below]" : ""}${c.sameSite ? " [another application for the same site]" : ""}`).join("\n")}\n` : ""}
Every rewrite (entry, heading, summary or decision), add_motion, set_stage, unlink_address and merge_address puts the records' own words it rests on in "source", quoted exactly; no other action needs a "source". A
"Not backed by the record" problem quotes what the record says: fix it by rewriting to what the record supports.
An entry with the wrong date usually means the record itself is filed at the wrong meeting: rewrite its line to state
the right date with the quote that gives it, or, if no record gives the right date, say cannot_fix and name exactly
which record and which date disagree. Work only from the records below and what you found, and never wait for more.
When they don't say something, fix with what they do say: rewrite the line or summary to what they support, and leave
out what they don't.
- Saying a record is silent: write that the record doesn't say what Council decided (or anything like it) only when
  that meeting's minutes are in your records (a "MINUTES OR REPORT TEXT FROM THIS MEETING" line, or minutes you read)
  and say nothing about it. Minutes are where decisions are recorded: a staff report proposes, the minutes say what
  Council did. Even then, lead with what is known, not with what is missing.
- Explain before removing: an entry whose title or records name this topic (or the same policy, bylaw, site or
  project) is explained with rewrite_entry, one line saying how it relates ("In 2012 Council set criteria for waiving
  hearings; the 2020 policy sets how hearings are run"), not removed. Remove it only when the records (or what you
  found) show it is about something else, and say what.
- move_documents: when the documents attached to an entry are about another item at the same meeting (an agenda
  reordered at the meeting can shift every report one item along), give the entry's key, the ids of the documents
  that belong elsewhere and to_item_id, the item at that meeting they are about. The flagged entries' documents and
  the other items at their meetings:
${attachments || "(No flagged entry has documents attached.)"}
- add_motion: an entry ("agenda-" or "mention-") whose decision the minutes record but the entry lacks: no MOTION line,
  or one listed under "PROPOSALS WHOSE OUTCOME WAS NOT FOUND" (ingest couldn't find its outcome, often because a
  scanned copy put "CARRIED" under the item before). Give motion_text exactly as the minutes word it, motion_result, mover and seconder if named, and in
  "source" the minutes passage word for word from the motion through its outcome. It is saved only if that passage is
  in this meeting's minutes or reports and itself says the outcome; never add a motion the minutes don't record.
- repoint_mention: a "mention-" entry that links only a section heading of the agenda ("5. PRESENTATIONS"), listed under
  SECTION HEADINGS ON THIS PAGE with the items under it and their records. Give the entry's key and to_item_id, the
  item under the heading this topic is about: the entry then links that item, with its own motions and reports
  (a decision recorded under that item belongs to it: never add_motion or move_motion it onto the heading). If none
  of the items is about this topic, remove_entry instead.
- move_motion: an entry ("agenda-" or "mention-") whose decision is already recorded at its meeting but filed under
  no item: listed under "DECISIONS RECORDED AT THESE MEETINGS BUT FILED UNDER NO ITEM". Give the entry's key and the
  MOTION id. It is moved, never copied, and only when its wording names what the entry is about (the address, bylaw
  or file number). Prefer this over add_motion whenever the motion is already in that list.
- set_stage: an "agenda-" entry whose stage line is wrong. The page guesses a step's stage from its wording, so a
  condition "prior to adoption" can read as the adoption, or a hearing being scheduled as the hearing itself. Pick
  the stage the records show: ${Object.entries(STAGE_LABELS).map(([k, v]) => `${k} ("${v}")`).join(", ")}, or none
  for a step that is no bylaw stage. "adopted" also gives a passed motion the Adopted badge. Quote the record in
  "source".
${REWRITE_DECISION_PROMPT}
${UNLINK_ADDRESS_PROMPT}
${MERGE_ADDRESS_PROMPT}
- hide_page: when nothing in the records backs this page at all (no step of its own, nothing showing what it's
  about), hide it from the public. It can be undone, and the editor confirms it like every other change.
Use cannot_fix only for a genuine judgement call none of these actions can make, and say precisely what is wrong and
where, not "a person should look". A cannot_fix names the record it needs (which meeting's minutes, which report or
bylaw, and its date) and what that record would settle.
Every line a resident reads (rewrite_entry, rewrite_heading, the summary instruction) follows the site's writing
style: outcome first, everyday words, short sentences, no file, bylaw or policy numbers, no database words
("matters", "records", "agenda items").

For each agreed problem (and anything the note asks), give at least one action: never leave one unanswered. An
instruction written as a question ("Is it relevant? If not, remove it") asks you to decide: act on it, or answer it
with no_change. Don't change anything the editor didn't
agree with or ask for.

Records (each item's motions, reports and minutes; "MINUTES OR REPORT TEXT FROM THIS MEETING" was found in the same
meeting's minutes or reports by the item's subject):
${records || "(none)"}

Timeline entries:
${entries.map((e) => `[${e.key}] ${e.text}`).join("\n\n")}`;
}

/** Motions ingest held back because their outcome wasn't found beside them (often a scanned copy filing "CARRIED"
 * under the item before), for the planner only: the page check never sees them, so it neither reads them as decisions
 * nor flags every such item for lacking one. */
async function heldBackMotions(supabase: SupabaseClient, ids: number[]): Promise<string> {
  if (!ids.length) return "";
  const { data } = await supabase.from("agenda_items").select("id, held:meta->unverified_motion_proposals").in("id", ids);
  const lines = ((data || []) as any[]).flatMap((row) => (Array.isArray(row.held) ? row.held : [])
    .filter((h: any) => h?.motion_text && !h.resolved_motion_id).map((h: any) => `- ITEM ${row.id}: ${String(h.motion_text)}`));
  return lines.length ? `PROPOSALS WHOSE OUTCOME WAS NOT FOUND (not decisions; add_motion one only when the minutes text above records its outcome):\n${lines.join("\n")}` : "";
}

/** Decisions the history catch-up recorded at a flagged entry's meeting but couldn't file under an item (its
 * "Official recorded motions" container), for the planner: it moves one onto the entry it decides. */
async function containerMotions(supabase: SupabaseClient, ids: number[]): Promise<string> {
  if (!ids.length) return "";
  const { data: items } = await supabase.from("agenda_items").select("id, meeting_id").in("id", ids);
  const meetingIds = [...new Set(((items || []) as any[]).map((i) => i.meeting_id).filter(Boolean))];
  if (!meetingIds.length) return "";
  const { data: containers } = await supabase.from("agenda_items").select("id, meeting_id").in("meeting_id", meetingIds)
    .or("item_order.eq.official-recorded-motions,title.ilike.Official recorded motions%");
  if (!containers?.length) return "";
  const { data: motions } = await supabase.from("motions").select("id, agenda_item_id, result, text_content")
    .in("agenda_item_id", (containers as any[]).map((c) => c.id)).order("id");
  const meetingOf = new Map((containers as any[]).map((c) => [c.id, c.meeting_id]));
  const lines = ((motions || []) as any[]).map((m) =>
    `- MOTION ${m.id} (meeting ${meetingOf.get(m.agenda_item_id)}, ${m.result || "result not recorded"}): ${String(m.text_content || "").replace(/\s+/g, " ").slice(0, 320)}`);
  return lines.length ? `DECISIONS RECORDED AT THESE MEETINGS BUT FILED UNDER NO ITEM (ingest couldn't tell which item each decides; move_motion one onto the entry it is about, by its MOTION id):\n${lines.join("\n")}` : "";
}

/** Runs the agent for one page. Never throws: a failure is written to the page as "needs work" with a note. Returns
 * "nothing_new" when every flag rated 👍 was already fixed and there's no note or found entry, so the caller can say
 * so rather than show the last run's report as if this run had done it. */
/** The most model time one fix may use. Past it the agent stops and says what is left, rather than hang the request. */
export const FIX_BUDGET_MS = 90_000;

export async function fixPage(supabase: SupabaseClient, origin: string, path: string, requester: { id: string; staffRole: StaffRole }): Promise<"nothing_new" | "refiling" | void> {
  // A meeting page has its own, smaller agent (its text is the highlights and the items' summaries).
  if (/^\/meetings\/[^/]+$/.test(path)) return fixMeetingPage(supabase, origin, path, requester);
  // A property page too: its lead and the entries linked to the address.
  if (/^\/properties\/[^/]+$/.test(path)) return fixPropertyPage(supabase, origin, path, requester);
  const startedAt = Date.now();
  // Every model call in the fix shares this deadline: when it fires, in-flight calls are cancelled.
  const budget = AbortSignal.timeout(FIX_BUDGET_MS);
  const timeLeft = () => FIX_BUDGET_MS - (Date.now() - startedAt);
  // The flags were read when the run started; staff may have rated more, or marked one handled, since.
  const withStaffRatings = async (mine: PageFlag[]) => {
    const { data: now } = await supabase.from("page_reviews").select("ai_flags").eq("path", path).maybeSingle();
    return keepStaffRatings(now?.ai_flags as PageFlag[] | null, mine);
  };
  // What the agent is doing now, shown in the bar while the page is "fixing" (it polls every 3 s). Best effort.
  const progress = (text: string) => {
    supabase.from("page_reviews").update({ agent_note: text, agent_at: new Date().toISOString() }).eq("path", path).eq("status", "fixing")
      .then(({ error }) => { if (error) console.error("[page-fix] progress:", error.message); });
  };
  const finish = async (status: "fixed" | "needs_work", agent_note: string, flags?: PageFlag[]) => {
    await supabase.from("page_reviews").update({
      status, agent_note, agent_at: new Date().toISOString(), ...(flags ? { ai_flags: await withStaffRatings(flags) } : {}),
    }).eq("path", path);
  };
  try {
    const { data: row } = await supabase.from("page_reviews").select("ai_flags, note, internal_note").eq("path", path).maybeSingle();
    const flags = ((row?.ai_flags || []) as PageFlag[]);
    const agreed = flags.filter((f) => f.verdict === "agree" && !f.fixed);
    const matterId = await matterForPath(supabase, path);
    if (!matterId) return finish("needs_work", "The agent fixes topic and meeting pages so far. This one needs a person.");
    // Entries the search found that staff rated 👍: added first, so the plan (and the one summary rewrite) sees them.
    const agreedFound = (await listSuggestions(supabase, matterId).catch(() => [] as Suggestion[])).filter((x) => x.agreed);
    if (!agreed.length && !row?.note && !agreedFound.length) {
      // Everything agreed is already fixed (perhaps by a run a moment ago): back to "fixed", as that run left it
      // (returning without that would leave the page saying the agent is still working).
      if (flags.some((f) => f.verdict === "agree" && f.fixed)) {
        await supabase.from("page_reviews").update({ status: "fixed" }).eq("path", path);
        return "nothing_new";
      }
      return finish("needs_work", "Nothing to fix: no flags were rated 👍 and there's no note.");
    }
    const added: { title: string; key: string | null }[] = [];
    const addedSuggestions = new Set<string>();
    for (const found of agreedFound) {
      try {
        await decideSuggestion(supabase, matterId, found.table, found.id, true, requester.id);
        added.push({ title: found.title, key: found.itemId ? `mention-${found.itemId}` : null });
        addedSuggestions.add(suggestionKey(found));
      } catch (error) {
        console.error("[page-fix] adding a found entry failed:", error instanceof Error ? error.message : error);
      }
    }
    const addedNote = added.length
      ? `Just added to this page from the search (staff agreed they belong): ${added.map((a) => `${a.key ? `[${a.key}] ` : ""}"${a.title}"`).join("; ")}. `
        + `If one is really this topic's own step (its adoption, a reading, its decision), file_here so the summary can rely on it.`
      : "";

    const page = readPage(await renderPage(origin, path));
    const itemId = (key: string | null | undefined) => Number(key?.match(/^(?:agenda|mention|background)-(\d+)$/)?.[1] ?? NaN);
    // An item's entry key can change after it was flagged (a related topic's entry becomes a direct mention when the
    // topics are regrouped): follow the item to its current key, and map fixes back to the flag's own key.
    const pageKeys = new Set(page.entries.map((e) => e.key));
    const renamed = new Map<string, string>();  // current key -> flagged key
    for (const flag of agreed) {
      if (!flag.key || pageKeys.has(flag.key) || !Number.isSafeInteger(itemId(flag.key))) continue;
      const now = ["agenda", "mention", "background"].map((k) => `${k}-${itemId(flag.key)}`).find((k) => pageKeys.has(k));
      if (now) { renamed.set(now, flag.key); flag.key = now; }
    }
    const movableKey = (key: string | null | undefined) => !!key && /^(agenda|mention|background)-\d+$/.test(key);
    const candidates = new Map<string, Candidate[]>();
    for (const flag of agreed.filter((f) => movableKey(f.key))) {
      const { data: item } = await supabase.from("agenda_items").select("title, related_address").eq("id", itemId(flag.key)).maybeSingle();
      candidates.set(flag.key!, item?.title ? await candidatesFor(supabase, matterId, item as any) : []);
    }
    // Each flagged entry's attached documents, and the other items at its meeting they might belong to (move_documents).
    const attachedTo = new Map<number, { docs: Set<number>; siblings: Set<number> }>();
    const attachmentLines: string[] = [];
    for (const flag of agreed.filter((f) => movableKey(f.key))) {
      const id = itemId(flag.key);
      if (attachedTo.has(id)) continue;
      const [{ data: docs }, { data: item }] = await Promise.all([
        supabase.from("extracted_documents").select("id, title").eq("agenda_item_id", id).order("id"),
        supabase.from("agenda_items").select("meeting_id").eq("id", id).maybeSingle(),
      ]);
      if (!docs?.length || !item?.meeting_id) continue;
      const { data: others } = await supabase.from("agenda_items").select("id, item_order, title")
        .eq("meeting_id", item.meeting_id).neq("id", id).order("id");
      attachedTo.set(id, { docs: new Set(docs.map((d: any) => d.id)), siblings: new Set((others || []).map((o: any) => o.id)) });
      attachmentLines.push(`- [${flag.key}] documents: ${docs.map((d: any) => `doc-${d.id} "${d.title}"`).join("; ")}\n` +
        `  other items at its meeting: ${(others || []).map((o: any) => `${o.id} "${[o.item_order, String(o.title || "").split("\n")[0]].filter(Boolean).join(" ")}"`).join("; ")}`);
    }
    // The records behind the page: every item filed here plus each flagged linked item, gathered the way the page
    // check gathers them (unattached minutes and reports of the same meeting included), and flagged report quotes.
    const { data: topic } = await supabase.from("matters").select("meta").eq("id", matterId).single();
    const own = await topicItemIds(supabase, matterId);
    const ids = [...new Set([...own, ...agreed.map((f) => itemId(f.key)).filter(Number.isSafeInteger)])];
    const reportIds = agreed.map((f) => Number(f.key?.match(/^report-(\d+)$/)?.[1] ?? NaN)).filter(Number.isSafeInteger);
    const evidenceIds = agreed.map((f) => Number(f.key?.match(/^evidence-(\d+)$/)?.[1] ?? NaN)).filter(Number.isSafeInteger);
    const heading = page.heading || page.title;
    // The agent investigates before it plans: every agreed flag (and the editor's note) is researched in all of the
    // City's records, with a question that fits the problem, in parallel while the page's own records load. A flag
    // the check already researched keeps that finding.
    const toResearch = agreed.filter((f) => !f.research && needsInvestigation(f)).length + (row?.note?.trim() ? 1 : 0);
    progress(toResearch ? `Reading the page's records and searching the City's records for ${toResearch === 1 ? "1 problem" : `${toResearch} problems`}…`
      : "Reading the page's records…");
    const [bylawText, { sources, textOf }] = await Promise.all([bylawRecords(supabase, matterId), sourcesFor(supabase, { matterId }).then((list) => loadSources(supabase, list))]);
    const sourceText = sourceRecordLines(sources);
    const [{ text: itemText }, { data: reports }, evidenceText, investigations] = await Promise.all([
      itemRecords(supabase, ids),
      reportIds.length ? supabase.from("matter_report_mentions").select("id, page, quote").in("id", reportIds) : Promise.resolve({ data: [] }),
      evidenceRecords(supabase, matterId, evidenceIds),
      investigate(supabase, { path, topic: heading, flags: agreed.map((flag) => ({ flag, index: flags.indexOf(flag) })),
        note: row?.note ?? null, signal: budget, records: bylawText }),
    ]);
    const findingFor = (i: Investigation | undefined) => findingText(i?.finding);
    // For the note: what the agent read for each problem, so the editor can see what each change rests on. It is
    // evidence, not a to-do list, and names entries the way the page does.
    const found = investigations.filter((i) => i.finding?.ref && i.finding.verdict !== "not_found");
    const lookedInto = found.length ? `Evidence, from the City's records:\n${found.map((i) =>
      `• ${capital(entryLabel(i.key, flags))}: ${brief(i.finding!.explanation, 220)} (${i.finding!.ref})`).join("\n")}` : "";
    const researchText = [investigations.map(investigationLine).filter(Boolean).join("\n"),
      await investigatedRecords(supabase, investigations)].filter(Boolean).join("\n\n");
    const [heldBack, unfiled] = await Promise.all([heldBackMotions(supabase, ids), containerMotions(supabase, ids)]);
    // A mention that links only a section heading: the items under it, with their records (repoint_mention).
    const headings = new Map<string, Awaited<ReturnType<typeof headingChildren>>>();
    const mentionIds = page.entries.filter((e) => e.key.startsWith("mention-")).map((e) => itemId(e.key)).filter(Number.isSafeInteger);
    const { data: mentionRows } = mentionIds.length ? await supabase.from("agenda_items").select("id, item_order").in("id", mentionIds) : { data: [] };
    for (const r of ((mentionRows || []) as any[]).filter((r) => isHeadingOrder(r.item_order))) {
      const children = await headingChildren(supabase, r.id);
      if (children.length) headings.set(`mention-${r.id}`, children);
    }
    const headingText = headings.size ? [`SECTION HEADINGS ON THIS PAGE (repoint_mention):\n${[...headings].map(([key, children]) =>
      `- [${key}] is only a heading; under it: ${children.map((c) => `${c.id} "${c.item_order} ${c.title}"${c.matter_id ? ` (filed on topic ${c.matter_id}${c.matter_id === matterId ? ", this one" : ""})` : ""}`).join("; ")}`).join("\n")}`,
      (await itemRecords(supabase, [...headings.values()].flat().map((c) => c.id))).text].join("\n") : "";
    const records = [itemText, bylawText, sourceText, heldBack, unfiled, headingText, ...((reports || []) as any[]).map((r) => `REPORT ENTRY report-${r.id} (annual report page ${r.page}): ${r.quote}`),
      evidenceText, researchText].filter(Boolean).join("\n\n");
    // Topics holding entries staff accepted for this page (found entries just added, mentions kept earlier) are often
    // a topic of their own that's really this one (a lone 2019 extension of an agreement this page already has, a
    // 2024 amendment of the same policy): offered for merging with their records, like Related topics.
    const [lookalikes, suggestions] = await Promise.all([
      relatedOrSameNamed(supabase, matterId, await acceptedOwners(supabase, matterId, added.map((a) => itemId(a.key)).filter(Number.isSafeInteger))),
      listSuggestions(supabase, matterId).catch(() => [] as Suggestion[])]);
    // Each topic listed under Related topics, or holding an accepted entry, is read from its own records (not its
    // model-written summary), so the agent can judge whether it's the same place or project: keep, unlink or merge.
    const relatedRecords = (await Promise.all(lookalikes.filter((c) => c.related || c.owner).slice(0, 8).map(async (c) => {
      const text = (await itemRecords(supabase, await topicItemIds(supabase, c.id)).catch(() => ({ text: "" }))).text;
      return text ? `${c.related ? "RELATED TOPIC" : "TOPIC HOLDING AN ACCEPTED ENTRY"} ${c.id} "${c.title}": its own records\n${text.slice(0, 30000)}` : "";
    }))).filter(Boolean).join("\n\n");
    // The decisions shown under the page's entries and the addresses mapped to it: rewrite_decision and unlink_address.
    const entryKeyOf = (id: number) => ["agenda", "mention", "background"].map((k) => `${k}-${id}`).find((k) => pageKeys.has(k)) ?? null;
    const [decisions, addresses] = await Promise.all([
      decisionLines(supabase, [...new Set(page.entries.map((e) => itemId(e.key)).filter(Number.isSafeInteger))]),
      mappedAddresses(supabase, matterId)]);
    const pageParts = [decisionsBlock(decisions, entryKeyOf), addressesBlock(addresses)].filter(Boolean).join("\n\n");
    progress("Planning the fix…");
    const result = await getAiClient().json({
      stage: "review",
      prompt: planPrompt(heading, page.entries, agreed, [row?.note, addedNote].filter(Boolean).join("\n\n") || null, candidates,
        [records, relatedRecords, pageParts].filter(Boolean).join("\n\n"), lookalikes, suggestions,
        (row as { internal_note?: string | null } | null)?.internal_note ?? null, attachmentLines.join("\n"),
        agreed.map((f) => findingFor(investigations.find((i) => i.index === flags.indexOf(f)))),
        findingFor(investigations.find((i) => i.index === null))),
      schema: PlanSchema,
      schemaName: "page_fix_plan",
      signal: budget,
    });

    const onPage = new Set(page.entries.map((e) => e.key));
    const done: string[] = added.length
      ? [`Added ${added.length === 1 ? "the entry" : `${added.length} entries`} the search found: ${added.map((a) => a.title).join("; ")}.`] : [];
    const left: string[] = [];
    const fixedKeys = new Set<string>();
    // Entries taken off the page. A rewritten entry is fixed but still there, so a later remove_entry still applies.
    const removed = new Set<string>();
    const moves: { item_id: number; to_matter_id: number | null; refile?: boolean; reason: string }[] = [];
    const mentionMoves: { item_id: number; to_matter_id: number; reason: string }[] = [];
    const merges: { with_matter_id: number; matter_id?: number; reason: string; key: string | null }[] = [];
    const rewrites: Record<string, string> = {};
    const lines: Record<string, { line?: string; heading?: string; source?: string }> = {};
    const summaryNotes: string[] = [];
    const waiting: string[] = [];
    const answered: string[] = [];
    const answeredKeys = new Set<string | null>();
    const hidden: Record<string, { keep: number; reason: string; by: string; at: string }> = {};
    // Kept on the item (agenda_items.meta.staff_stage), so it follows the item if it is moved or re-filed.
    const stages: Record<string, { stage: StageChoice; source: string; reason: string; by: string; at: string }> = {};
    // Motions added from the minutes: their meetings' topic statuses are refreshed and their topics rewritten below.
    const addedMotions: { key: string; text: string; result: string; quote: string; meetingId: number; matterId: number | null }[] = [];
    let summaryUnfollowed = false;
    // file_here for an item another topic holds: settled after the plan by comparing the two topics' records.
    const heldElsewhere: { key: string; owner: number; reason: string }[] = [];
    const quoteOf =(step: { source: string | null }) => (step.source || "").replace(/\s+/g, " ").trim();
    // A flagged entry that has left the page since (its topic merged in or unlinked, the entry removed or moved) needs
    // nothing more: the flag is done, whatever the plan says for it.
    const gone = agreed.filter((f) => f.key && !f.fixed && !onPage.has(f.key));
    for (const f of gone) fixedKeys.add(f.key!);
    if (gone.length) answered.push(`Already off the page since it was flagged: ${gone.map((f) => f.key).join(", ")}.`);
    progress(`Making ${result.data.actions.length === 1 ? "1 change" : `${result.data.actions.length} changes`}…`);
    for (const step of result.data.actions) {
      if (step.key && !onPage.has(step.key) && fixedKeys.has(step.key)) continue;
      // A flag on a Related topics card names the topic in its key.
      const relatedId = Number(step.key?.match(/^related-(\d+)$/)?.[1] ?? NaN);
      if ((step.action === "unlink_related" || step.action === "merge_topic") && !step.to_matter_id && Number.isSafeInteger(relatedId)) {
        step.to_matter_id = relatedId;
      }
      if (step.action === "merge_topic" && step.to_matter_id && lookalikes.some((c) => c.id === step.to_matter_id)) {
        const other = step.other_matter_id && step.other_matter_id !== step.to_matter_id
          && lookalikes.some((c) => c.id === step.other_matter_id) ? step.other_matter_id : null;
        // Two related topics merged with each other, or one merged into this page. The flag's key goes along, so the
        // pipeline marks it fixed once the merge is done.
        merges.push(other ? { matter_id: other, with_matter_id: step.to_matter_id, reason: step.reason, key: step.key ?? null }
          : { with_matter_id: step.to_matter_id, reason: step.reason, key: step.key ?? null });
        continue;
      }
      if (step.action === "no_change") {
        answered.push(step.reason);
        answeredKeys.add(step.key && onPage.has(step.key) ? step.key : null);
        continue;
      }
      if (step.action === "unlink_related" && step.to_matter_id && lookalikes.some((c) => c.id === step.to_matter_id && c.related)) {
        const { error } = await supabase.from("matter_links").update({ hidden: true, review: "removed", reviewed_by: requester.id, reviewed_at: new Date().toISOString() })
          .eq("kind", "related_matter")
          .or(`and(matter_id.eq.${matterId},related_matter_id.eq.${step.to_matter_id}),and(matter_id.eq.${step.to_matter_id},related_matter_id.eq.${matterId})`);
        if (error) left.push(`${step.reason} (unlinking it didn't work)`);
        else {
          done.push(`Unlinked the related topic: ${step.reason}`);
          answeredKeys.add(null);
          fixedKeys.add(`related-${step.to_matter_id}`);
          await logStaffAction(supabase, { userId: requester.id, role: requester.staffRole, path, action: "agent:unlink_related",
            detail: { matter_id: String(step.to_matter_id), reason: step.reason.slice(0, 400) } });
        }
        continue;
      }
      if (step.action === "hide_page") {
        try {
          await setTopicHidden(supabase, matterId, true, requester.id);
          done.push(`Hid this page from the public: ${step.reason} (Show this page again from the bar to undo.)`);
        } catch {
          left.push(`${step.reason} (hiding the page didn't work)`);
        }
        continue;
      }
      if (step.action === "accept_suggestion") {
        const found = suggestions.find((x) => suggestionKey(x) === step.key);
        // The check's fix often names a suggestion staff agreed to, which was added above: nothing left to do.
        if (!found && await suggestionOnPage(supabase, step.key, addedSuggestions)) continue;
        if (!found || found.kind === "related") left.push(`${step.reason} (that suggestion isn't one the agent can add${found ? "; related topics are added by an editor" : ""})`);
        else {
          try {
            await decideSuggestion(supabase, matterId, found.table, found.id, true, requester.id);
            done.push(`Added the suggested entry: ${step.reason}`);
          } catch {
            left.push(`${step.reason} (adding it didn't work)`);
          }
        }
        continue;
      }
      if (step.action === "hide_duplicate" && step.key?.startsWith("agenda-") && onPage.has(step.key)
          && step.keep_key?.startsWith("agenda-") && onPage.has(step.keep_key) && step.keep_key !== step.key) {
        const { data: pair } = await supabase.from("agenda_items").select("id, meeting_id, item_order, title")
          .in("id", [itemId(step.key), itemId(step.keep_key)]);
        const [a, b] = (pair || []) as any[];
        const sameTitle = (x: any, y: any) => String(x?.title || "").split("\n")[0].toLowerCase().replace(/\W+/g, " ").trim()
          === String(y?.title || "").split("\n")[0].toLowerCase().replace(/\W+/g, " ").trim();
        if (a && b && a.meeting_id === b.meeting_id && (a.item_order === b.item_order || sameTitle(a, b))) {
          // One agenda record stored twice: that is merged with the agenda duplicate repair, not hidden.
          left.push(`${step.reason} (items ${itemId(step.key)} and ${itemId(step.keep_key)} are the same agenda record stored twice; merge them with research/data-integrity/merge_agenda_duplicates_20261030.py --map ${itemId(step.key)}:${itemId(step.keep_key)})`);
        } else {
          hidden[String(itemId(step.key))] = { keep: itemId(step.keep_key), reason: step.reason.slice(0, 300), by: requester.id, at: new Date().toISOString() };
          fixedKeys.add(step.key);
          done.push(`Hid ${entryLabel(step.key, flags)} as a duplicate: ${step.reason}`);
        }
        continue;
      }
      if (step.action === "file_here" && step.key?.startsWith("mention-") && onPage.has(step.key)) {
        const { data: item } = await supabase.from("agenda_items").select("matter_id, meta").eq("id", itemId(step.key)).maybeSingle();
        const lock = (item?.meta as any)?.staff_matter;
        // An item on a bundle topic (a meeting's committee resolutions, a consent agenda) covers other subjects too, so
        // it can't be filed here: it rightly stays a mention on this page, and its line says what it shows.
        const home = item?.matter_id && item.matter_id !== matterId
          ? (await supabase.from("matters").select("meta").eq("id", item.matter_id).maybeSingle()).data : null;
        if (item && !lock && (home?.meta as any)?.hidden === "container") {
          fixedKeys.add(step.key);
          done.push(`Kept ${entryLabel(step.key, flags)} as a mention: it's part of a bundle of resolutions about other subjects too.`);
        } else if (!item) left.push(`${step.reason} (that item couldn't be found)`);
        else if (lock && "matter_id" in lock && lock.matter_id !== matterId) left.push(`${step.reason} (an editor placed that item ${lock.matter_id ? `on topic ${lock.matter_id}` : "off every topic"}, so it stays there)`);
        else if (item.matter_id && item.matter_id !== matterId) {
          // Filed on another topic: the agent compares the two topics' records below and merges them if they're one project.
          heldElsewhere.push({ key: step.key, owner: item.matter_id, reason: step.reason });
        } else {
          moves.push({ item_id: itemId(step.key), to_matter_id: matterId, reason: step.reason });
          fixedKeys.add(step.key);
        }
        continue;
      }
      if (step.action === "rewrite_summary" && (step.new_text || "").trim()) {
        summaryNotes.push(summaryInstruction(step.new_text, step.source)!);
        done.push(`Rewrote the summary: ${brief(step.reason, 200)}`);
        continue;
      }
      if (step.action === "edit_source") {
        const result = await editSourceOnPage(supabase, step, { sources, textOf, records,
          flagged: (k) => !!k && onPage.has(k) && agreed.some((f) => f.key === k) });
        if (!result.ok) { left.push(`${step.reason} (${result.why})`); continue; }
        fixedKeys.add(`source-${result.source.id}`);
        done.push(`Corrected ${entryLabel(`source-${result.source.id}`, flags)}${result.edit.headline ? `, now headed "${result.edit.headline}"` : ""}: ${brief(step.reason, 200)}`);
        await logStaffAction(supabase, { userId: requester.id, role: requester.staffRole, path, action: "agent:edit_source",
          detail: { source_id: String(result.source.id), ...Object.fromEntries(Object.entries(result.edit).map(([k, v]) => [k, v.slice(0, 300)])), reason: step.reason.slice(0, 300) } });
        continue;
      }
      if ((step.action === "rewrite_entry" || step.action === "rewrite_heading") && step.key && onPage.has(step.key)
          && /^(agenda|mention|background|report|evidence)-\d+$/.test(step.key)) {
        const text = (step.new_text || "").replace(/\s+/g, " ").trim();
        const heading = step.action === "rewrite_heading";
        if (!quoteOf(step)) {
          left.push(`${step.reason} (no record says it, so nothing changed)`);
        } else if (text.length < (heading ? 6 : 15) || text.length > (heading ? 120 : 180) || (heading && step.key.startsWith("agenda-"))) {
          left.push(`${step.reason} (the new ${heading ? "heading" : "line"} wasn't usable, so nothing changed)`);
        } else {
          if (!heading && step.key.startsWith("agenda-")) rewrites[step.key.slice(7)] = text;
          else lines[step.key] = { ...lines[step.key], [heading ? "heading" : "line"]: text, source: quoteOf(step) };
          fixedKeys.add(step.key);
          done.push(`${capital(entryLabel(step.key, flags))} now ${heading ? "headed" : "reads"}: "${text}"`);
        }
        continue;
      }
      if (step.action === "add_motion" && step.key && /^(agenda|mention)-\d+$/.test(step.key) && onPage.has(step.key)) {
        if (!step.motion_text?.trim() || !step.motion_result || !quoteOf(step)) {
          left.push(`${step.reason} (no minutes passage was given for the motion, so nothing changed)`);
          continue;
        }
        try {
          const added = await addMotion(supabase, itemId(step.key), { item_key: step.key, motion_text: step.motion_text, result: step.motion_result,
            mover: step.mover, seconder: step.seconder, quote: quoteOf(step) }, requester);
          addedMotions.push({ key: step.key, text: step.motion_text.trim(), result: step.motion_result, quote: quoteOf(step),
            meetingId: added.meetingId, matterId: added.matterId });
          fixedKeys.add(step.key);
          done.push(`Added the motion to ${entryLabel(step.key, flags)}: ${brief(step.reason, 200)}`);
          await logStaffAction(supabase, { userId: requester.id, role: requester.staffRole, path, action: "agent:add_motion",
            detail: { agenda_item_id: String(itemId(step.key)), motion_id: String(added.motionId), document_id: String(added.documentId ?? ""),
              reason: step.reason.slice(0, 400) } });
        } catch (error) {
          left.push(`${step.reason} (the motion wasn't added: ${error instanceof Error ? error.message : "unknown error"})`);
        }
        continue;
      }
      if (step.action === "move_motion" && step.key && /^(agenda|mention)-\d+$/.test(step.key) && onPage.has(step.key)) {
        if (!step.motion_id) {
          left.push(`${step.reason} (no motion was named, so nothing changed)`);
          continue;
        }
        try {
          const moved = await moveMotion(supabase, itemId(step.key), step.motion_id, requester, step.reason);
          const text = moved.text.replace(/\s+/g, " ").trim();
          addedMotions.push({ key: step.key, text, result: moved.result, quote: text, meetingId: moved.meetingId, matterId: moved.matterId });
          fixedKeys.add(step.key);
          done.push(`Moved the meeting's recorded decision onto ${entryLabel(step.key, flags)}: ${brief(step.reason, 200)}`);
          await logStaffAction(supabase, { userId: requester.id, role: requester.staffRole, path, action: "agent:move_motion",
            detail: { agenda_item_id: String(itemId(step.key)), motion_id: String(moved.motionId), from_item_id: String(moved.fromItemId),
              reason: step.reason.slice(0, 400) } });
        } catch (error) {
          left.push(`${step.reason} (the motion wasn't moved: ${error instanceof Error ? error.message : "unknown error"})`);
        }
        continue;
      }
      if (step.action === "rewrite_decision") {
        const result = await rewriteDecision(supabase, step, { decisions, records, by: requester.id });
        if (!result.ok) { left.push(`${step.reason} (${result.why})`); continue; }
        const key = entryKeyOf(result.decision.itemId);
        if (key) fixedKeys.add(key);
        done.push(`The decision under ${entryLabel(key, flags)} now reads: "${result.text}"`);
        await logStaffAction(supabase, { userId: requester.id, role: requester.staffRole, path, action: "agent:rewrite_decision",
          detail: { motion_id: String(result.decision.id), text: result.text, reason: step.reason.slice(0, 300) } });
        continue;
      }
      if (step.action === "unlink_address") {
        const result = await unlinkAddress(supabase, matterId, step, { addresses, records });
        if (!result.ok) { left.push(`${step.reason} (${result.why})`); continue; }
        if (step.key && onPage.has(step.key)) fixedKeys.add(step.key);
        else answeredKeys.add(null);
        done.push(`Took ${result.address.address} off this topic's addresses: ${brief(step.reason, 200)}`);
        await logStaffAction(supabase, { userId: requester.id, role: requester.staffRole, path, action: "agent:unlink_address",
          detail: { property_id: String(result.address.id), matter_id: String(matterId), reason: step.reason.slice(0, 300) } });
        continue;
      }
      if (step.action === "repoint_mention" && step.key && headings.has(step.key) && onPage.has(step.key) && step.to_item_id) {
        try {
          const said = await repointMention(supabase, matterId, itemId(step.key), step.to_item_id, requester.id);
          fixedKeys.add(step.key);
          delete lines[step.key];  // a line written for the heading would now describe another item
          done.push(`${capital(entryLabel(step.key, flags))} linked only the agenda heading. ${said} ${brief(step.reason, 160)}`);
          await logStaffAction(supabase, { userId: requester.id, role: requester.staffRole, path, action: "agent:repoint_mention",
            detail: { from_item_id: String(itemId(step.key)), to_item_id: String(step.to_item_id), reason: step.reason.slice(0, 300) } });
        } catch (error) {
          left.push(`${step.reason} (${error instanceof Error ? error.message : "it didn't work"})`);
        }
        continue;
      }
      if (step.action === "merge_address") {
        const from = addresses.find((a) => a.id === step.property_id), into = addresses.find((a) => a.id === step.into_property_id);
        const why = !from || !into ? "both addresses must be mapped to this topic"
          : !quoteInRecords(step.source, records) ? "its quote isn't the record's exact words"
          : await mergeAddress(supabase, from, into, requester.id);
        if (why) { left.push(`${step.reason} (${why}, so nothing changed)`); continue; }
        addresses.splice(addresses.indexOf(from!), 1);
        if (step.key && onPage.has(step.key)) fixedKeys.add(step.key);
        else answeredKeys.add(null);
        done.push(`Merged ${from!.address} into ${into!.address}; its page now redirects there: ${brief(step.reason, 200)}`);
        await logStaffAction(supabase, { userId: requester.id, role: requester.staffRole, path, action: "agent:merge_address",
          detail: { from: String(from!.id), into: String(into!.id), reason: step.reason.slice(0, 300) } });
        continue;
      }
      if (step.action === "set_stage" && step.key?.startsWith("agenda-") && onPage.has(step.key) && step.stage) {
        if (!quoteOf(step)) {
          left.push(`${step.reason} (no record says it, so nothing changed)`);
          continue;
        }
        stages[step.key] = { stage: step.stage, source: quoteOf(step), reason: step.reason.slice(0, 300), by: requester.id, at: new Date().toISOString() };
        fixedKeys.add(step.key);
        const label = step.stage === "none" ? "no stage" : STAGE_LABELS[step.stage].replace(/\.$/, "");
        done.push(`Marked ${entryLabel(step.key, flags)} as “${label}”: ${brief(step.reason, 200)}`);
        continue;
      }
      if (step.action === "move_documents" && step.key && onPage.has(step.key) && step.to_item_id && step.document_ids?.length) {
        const at = attachedTo.get(itemId(step.key));
        const ids = step.document_ids.filter((d) => at?.docs.has(d));
        if (at && ids.length && at.siblings.has(step.to_item_id)) {
          // The documents and their text sections follow the item they're about (as the pipeline's relink writes them).
          const { error: sectionError } = await supabase.from("document_sections").update({ agenda_item_id: step.to_item_id }).in("extracted_document_id", ids);
          const { error } = sectionError ? { error: sectionError } : await supabase.from("extracted_documents").update({ agenda_item_id: step.to_item_id }).in("id", ids);
          if (!error) {
            done.push(`Moved the documents to the right item: ${step.reason}`);
            fixedKeys.add(step.key);
            continue;
          }
        }
        left.push(`${step.reason} (the documents couldn't be moved)`);
        continue;
      }
      if (step.action === "unfile_item" && step.key?.startsWith("agenda-") && onPage.has(step.key)) {
        moves.push({ item_id: itemId(step.key), to_matter_id: null, reason: step.reason });
        continue;
      }
      if (step.action === "move_item" && movableKey(step.key) && onPage.has(step.key!)) {
        const offered = candidates.get(step.key!)?.some((c) => c.id === step.to_matter_id);
        // A topic that wasn't offered: an item filed here is re-filed the way ingest would; a mention or borrowed
        // entry already lives on its own topic, so it simply comes off this page.
        const target = offered ? step.to_matter_id : null;
        if (step.key!.startsWith("agenda-")) {
          moves.push({ item_id: itemId(step.key), to_matter_id: target, refile: target === null, reason: step.reason });
        } else if (target !== null && step.key!.startsWith("mention-")) {
          mentionMoves.push({ item_id: itemId(step.key), to_matter_id: target, reason: step.reason });
        } else {
          // A mention with nowhere better to go is simply not about this topic.
          try {
            await removeEntry(supabase, matterId, step.key!, requester.id);
            fixedKeys.add(step.key!);
            removed.add(step.key!);
            done.push(`Took ${entryLabel(step.key, flags)} off this page: ${step.reason}`);
          } catch (error) {
            left.push(`${step.reason} (it didn't work: ${error instanceof Error ? error.message : "unknown error"})`);
          }
        }
        continue;
      }
      if (step.action === "remove_entry" && step.key && removableKey(step.key) && onPage.has(step.key) && !removed.has(step.key)) {
        try {
          await removeEntry(supabase, matterId, step.key, requester.id);
          fixedKeys.add(step.key);
          removed.add(step.key);
          // A line or heading rewritten earlier in this plan would be saved for an entry that's gone.
          delete lines[step.key];
          done.push(`Removed ${entryLabel(step.key, flags)}: ${step.reason}`);
          await logStaffAction(supabase, {
            userId: requester.id, role: requester.staffRole, path, action: "agent:remove_entry",
            detail: { key: step.key, reason: step.reason.slice(0, 400) },
          });
        } catch (error) {
          left.push(`${step.reason} (it didn't work: ${error instanceof Error ? error.message : "unknown error"})`);
        }
      } else if (step.action === "remove_entry" && step.key && removed.has(step.key)) {
        continue; // Already taken off by an earlier step of this plan.
      } else {
        const why = step.action === "cannot_fix" ? "" : step.key && !onPage.has(step.key) ? " (that entry isn't on the page any more)"
          : " (that action doesn't apply to this entry)";
        left.push(`${step.reason}${why}`);
      }
    }
    await settleHeldElsewhere(supabase, matterId, heldElsewhere, merges, budget, { answered, answeredKeys, left });
    for (const move of mentionMoves) {
      // The link is re-pointed, not dropped: the mention now shows on the topic it's about.
      const { data: moved, error } = await supabase.from("matter_links").update({ matter_id: move.to_matter_id })
        .eq("matter_id", matterId).eq("agenda_item_id", move.item_id).eq("kind", "mention").select("id");
      if (error || !moved?.length) {
        // Usually the other topic already links that item (or holds it): then it only needs to come off this page.
        try {
          await removeEntry(supabase, matterId, `mention-${move.item_id}`, requester.id);
          fixedKeys.add(`mention-${move.item_id}`);
          done.push(`Took ${entryLabel(`mention-${move.item_id}`, flags)} off this page: ${move.reason}`);
        } catch {
          left.push(`${move.reason} (it didn't work: the link couldn't be moved or removed)`);
        }
        continue;
      }
      fixedKeys.add(`mention-${move.item_id}`);
      done.push(`Moved ${entryLabel(`mention-${move.item_id}`, flags)} to the topic it's about: ${move.reason}`);
      await logStaffAction(supabase, { userId: requester.id, role: requester.staffRole, path, action: "agent:move_mention",
        detail: { agenda_item_id: String(move.item_id), from: String(matterId), to: String(move.to_matter_id), reason: move.reason.slice(0, 400) } });
    }
    if (Object.keys(rewrites).length || Object.keys(lines).length) {
      const error = await writeEntryText(supabase, matterId, { headlines: rewrites, lines });
      if (error) {
        for (const id of Object.keys(rewrites)) fixedKeys.delete(`agenda-${id}`);
        for (const key of Object.keys(lines)) fixedKeys.delete(key);
        left.push("Couldn't save the rewritten lines.");
      } else {
        await logStaffAction(supabase, { userId: requester.id, role: requester.staffRole, path, action: "agent:rewrite_entry",
          detail: { ...Object.fromEntries(Object.entries(rewrites).map(([id, text]) => [`item ${id}`, text])),
            ...Object.fromEntries(Object.entries(lines).map(([key, v]) => [key, [v.heading, v.line].filter(Boolean).join(" | ")])) } });
      }
    }
    if (Object.keys(hidden).length) {
      // Reversible: the item stays on the topic; the page leaves it out of the timeline as a repeat of the kept entry.
      const { data: matter } = await supabase.from("matters").select("meta").eq("id", matterId).single();
      const meta = (matter?.meta || {}) as Record<string, any>;
      await supabase.from("matters").update({ meta: { ...meta, hidden_duplicates: { ...(meta.hidden_duplicates || {}), ...hidden } } })
        .eq("id", matterId);
      await logStaffAction(supabase, { userId: requester.id, role: requester.staffRole, path, action: "agent:hide_duplicate",
        detail: Object.fromEntries(Object.entries(hidden).map(([id, h]) => [`item ${id}`, `kept item ${h.keep}`])) });
    }
    for (const [key, staffStage] of Object.entries(stages)) {
      const { data: item } = await supabase.from("agenda_items").select("meta").eq("id", itemId(key)).single();
      const { error } = await supabase.from("agenda_items").update({ meta: { ...((item?.meta || {}) as Record<string, any>), staff_stage: staffStage } })
        .eq("id", itemId(key));
      if (error) {
        fixedKeys.delete(key);
        delete stages[key];
        left.push(`Couldn't save the stage of ${entryLabel(key, flags)}.`);
      } else {
        await logStaffAction(supabase, { userId: requester.id, role: requester.staffRole, path, action: "agent:set_stage",
          detail: { agenda_item_id: String(itemId(key)), stage: staffStage.stage, reason: staffStage.reason } });
      }
    }
    if (summaryNotes.length) {
      // Kept on the topic: this rewrite and every later one follow them (topic-summaries.server.ts, pipeline matter_summaries).
      await saveEditorNotes(supabase, matterId, summaryNotes);
      await logStaffAction(supabase, { userId: requester.id, role: requester.staffRole, path, action: "agent:rewrite_summary",
        detail: { notes: summaryNotes.join(" | ").slice(0, 500) } });
    }
    // Moves, merges and the summary rewrite happen here, in this request. Only re-filing an item the way ingest files
    // it (no listed topic fits) needs the pipeline's matcher: that one step goes to its quick worker, after the rest.
    const refiles: typeof moves = [];
    let rewrote: number[] = [];
    if (moves.length || merges.length || done.length) {
      const touched = new Set<number>([matterId]);
      // A motion added from the minutes can settle a topic's status (an adoption): its meeting is refreshed and its
      // topic rewritten, like a move.
      const meetings = new Set<number>(addedMotions.map((m) => m.meetingId));
      for (const m of addedMotions) if (m.matterId) touched.add(m.matterId);
      for (const move of moves) {
        try {
          const { data: item } = await supabase.from("agenda_items").select("matter_id").eq("id", move.item_id).single();
          // A "move" onto the topic it's already on, or onto no listed topic: re-filed by the worker.
          if ((move.refile && move.to_matter_id === null) || (move.to_matter_id !== null && move.to_matter_id === item?.matter_id)) {
            refiles.push({ ...move, to_matter_id: null, refile: true });
            continue;
          }
          const result = await moveItem(supabase, move.item_id, move.to_matter_id, requester.id, move.reason);
          for (const m of [result.from, result.to]) if (m) touched.add(m);
          meetings.add(result.meetingId);
          fixedKeys.add(`agenda-${move.item_id}`);
          done.push(move.reason || `Moved item ${move.item_id}.`);
          await logStaffAction(supabase, { userId: requester.id, role: requester.staffRole, path, action: "agent:move_item",
            detail: { agenda_item_id: String(move.item_id), from: String(result.from), to: String(result.to), reason: move.reason.slice(0, 400) } });
        } catch (error) {  // one failed move doesn't stop the rest
          left.push(`${move.reason || `Moving item ${move.item_id}`} (it didn't work: ${error instanceof Error ? error.message : "unknown error"})`);
        }
      }
      for (const merge of merges) {
        const a = merge.matter_id ?? matterId, b = merge.with_matter_id;
        try {
          // The page being fixed keeps its address.
          const result = await mergeFlat(supabase, [a, b], a);
          if (!result.aliases.length) continue;
          touched.add(result.canonical);
          for (const k of [merge.key, `related-${a}`, `related-${b}`]) if (k) fixedKeys.add(k);
          done.push(merge.reason || `Merged topic ${b} into this one.`);
          await logStaffAction(supabase, { userId: requester.id, role: requester.staffRole, path, action: "agent:merge_topic",
            detail: { canonical: String(result.canonical), aliases: result.aliases.join(","), reason: merge.reason.slice(0, 400) } });
        } catch (error) {
          left.push(`${merge.reason || "Merging a duplicate topic"} (it didn't work: ${error instanceof Error ? error.message : "unknown error"})`);
        }
      }
      for (const meetingId of meetings) {
        await refreshMeetingLifecycles(supabase, meetingId).catch((error) =>
          console.error(`[page-fix] lifecycle refresh for meeting ${meetingId} failed:`, error instanceof Error ? error.message : error));
      }
      // Topics merged away during this fix are rewritten as the topic they were merged into.
      const { data: current } = await supabase.from("matters").select("id, merged_into").in("id", [...touched]);
      const pageTopic = ((current || []) as any[]).find((m) => m.id === matterId);
      progress("Rewriting the summary and checking it against the records…");
      const report = await rewriteSummaries(supabase, ((current || []) as any[]).map((m) => m.merged_into || m.id),
        { notes: summaryNotes.map((note) => ({ matter_id: pageTopic?.merged_into || matterId, note })), signal: budget });
      rewrote = report.written;
      if (rewrote.length && (moves.length > refiles.length || merges.length)) {
        done.push(`Rewrote the summary of ${rewrote.length} ${rewrote.length === 1 ? "topic" : "topics"} whose timeline changed.`);
      }
      // One check judged the facts and each approved instruction together; what it found was edited directly (no second
      // rewrite) and checked once more.
      if (report.edited.length) done.push("Edited the summary directly, since the first draft didn't follow the instructions or the records.");
      for (const u of report.unfollowed) {
        left.push(unfollowedLine(u));
        const said = u.note.split(" The record says:")[0].slice(0, 80);
        for (let i = done.length - 1; i >= 0; i--) if (done[i].includes(said)) done.splice(i, 1);
      }
      // A summary or "where it stands" line a person edited by hand was kept, so an instruction about it wasn't carried out.
      const blocked = (report.heldByHand.get(pageTopic?.merged_into || matterId) || []).filter((f) => f !== "title");
      if (blocked.length && summaryNotes.length) {
        left.push(heldByHandLine("this topic", blocked));
        for (let i = done.length - 1; i >= 0; i--) if (done[i].startsWith("Rewrote the summary")) done.splice(i, 1);
      }
      summaryUnfollowed = report.unfollowed.length > 0 || (blocked.length > 0 && summaryNotes.length > 0);
      if (budget.aborted && (!rewrote.length || report.unfollowed.length)) {
        left.push("Ran out of time (about 90 seconds of model work) before the summary rewrite and its check finished. Press Fix again to finish it.");
      }
    }
    // Any agreed flag on an entry that's now gone is resolved, whichever step removed it; a whole-page issue is
    // resolved by a summary rewrite that follows its instruction.
    // An answered question (no_change) or an unlinked related topic settles the flag it was about.
    const settled = (f: PageFlag) => f.verdict === "agree" && (answeredKeys.has(f.key ?? null) || (!f.key && answeredKeys.has(null)));
    const updated = flags.map((f) => (f.key && fixedKeys.has(f.key)) || (!f.key && f.verdict === "agree" && summaryNotes.length && !summaryUnfollowed) || settled(f)
      ? { ...f, key: renamed.get(f.key!) ?? f.key, fixed: true } : { ...f, key: renamed.get(f.key!) ?? f.key });
    if (refiles.length) {
      // The pipeline's quick worker re-files these items, rewrites the summaries they leave and join, then finishes the
      // page with this run's report (done, left, waiting) and its own.
      const { data: municipality } = await supabase.from("municipalities").select("id").order("id").limit(1).maybeSingle();
      const { error } = await supabase.from("pipeline_jobs").insert({
        municipality_id: municipality?.id ?? 1, job_type: "fix_page", requested_by: requester.id, max_attempts: 1, priority: INTERACTIVE_JOB_PRIORITY,
        args: { path, moves: refiles, merges: [], refresh: [], done, left, waiting, summary_notes: [],
          requested_by: requester.id, role: requester.staffRole },
      });
      if (!error) {
        const count = `${refiles.length} ${refiles.length === 1 ? "item" : "items"}`;
        await supabase.from("page_reviews").update({
          ai_flags: await withStaffRatings(updated), agent_at: new Date().toISOString(),
          agent_note: [done.length ? `Changed:\n${done.map((d) => `• ${d}`).join("\n")}` : "",
            left.length ? `Needs a person:\n${left.map((d) => `• ${d}`).join("\n")}` : "",
            `Still to do, on the pipeline worker: re-file ${count} the way new meetings are filed (no listed topic fits), then rewrite the summaries they leave and join.`]
            .filter(Boolean).join("\n\n"),
        }).eq("path", path);
        return "refiling";
      }
      left.push(`Couldn't hand the re-filing of ${refiles.length === 1 ? "an item" : "items"} to the pipeline worker, so ${refiles.length === 1 ? "it stays" : "they stay"} where ${refiles.length === 1 ? "it is" : "they are"}.`);
    }
    // The fix is checked in the same request: only what it wrote (the new summary and status, rewritten lines, and the
    // statements behind each fixed flag), in one call, and a fix that doesn't hold is reopened. Never the whole page.
    const newlyFixed = updated.map((f, i) => (f.fixed && !flags[i].fixed ? i : -1)).filter((i) => i >= 0);
    let finalFlags = updated;
    let checkedNote = "";
    let recheckFailed = false;
    if (newlyFixed.length && timeLeft() > 10_000) {
      progress("Checking that the fixes hold…");
      try {
        const summaryScope = !!rewrote.length || summaryNotes.length > 0;
        const [{ data: fresh }, own2] = await Promise.all([
          supabase.from("matters").select("plain_english_summary, meta").eq("id", matterId).single(),
          topicItemIds(supabase, matterId),
        ]);
        const meta = ((fresh?.meta || {}) as Record<string, any>);
        const covered = (await itemRecords(supabase, [...new Set([...own2, ...ids])]));
        const claims: Claim[] = [];
        const summaryIds: string[] = [];
        if (summaryScope && covered.covered.size > 0) {
          for (const [i, t] of sentences(fresh?.plain_english_summary || "").entries()) { claims.push({ id: `summary-${i}`, key: null, text: `Summary: ${t}` }); summaryIds.push(`summary-${i}`); }
          if (meta.status_line) { claims.push({ id: "status", key: null, text: `Where it stands: ${meta.status_line}` }); summaryIds.push("status"); }
        }
        for (const id of Object.keys(rewrites)) {
          const text = meta.timeline_headlines?.[id];
          if (text && covered.covered.has(Number(id))) claims.push({ id: `line-${id}`, key: `agenda-${id}`, text: `Timeline line for item ${id}: ${text}` });
        }
        for (const key of Object.keys(lines)) {
          const v = meta.entry_lines?.[key];
          const text = [v?.heading, v?.line].filter(Boolean).join(" | ");
          if (text) claims.push({ id: `entry-${key}`, key, text: `Entry ${key}: ${text}` });
        }
        for (const m of addedMotions) {
          claims.push({ id: `motion-${m.key}`, key: m.key, text: `Decision added to ${m.key}: "${m.text}" (${m.result}). The minutes passage it rests on: "${m.quote}"` });
        }
        for (const [key, v] of Object.entries(stages)) {
          claims.push({ id: `stage-${key}`, key, text: `Stage of ${key}: ${v.stage === "none" ? "no bylaw stage" : STAGE_LABELS[v.stage as keyof typeof STAGE_LABELS]}` });
        }
        const scopes = new Map<number, string[]>();
        for (const i of newlyFixed) {
          const key = flags[i].key;
          const claimIds = !key ? summaryIds : [`line-${key.replace(/^agenda-/, "")}`, `entry-${key}`, `motion-${key}`, `stage-${key}`].filter((c) => claims.some((x) => x.id === c));
          if (claimIds.length) scopes.set(i, claimIds);
        }
        const records = [covered.text, bylawText, sourceText, ...((reports || []) as any[]).map((r) => `REPORT ENTRY report-${r.id} (annual report page ${r.page}): ${r.quote}`),
          evidenceText, researchText].filter(Boolean).join("\n\n");
        const verdicts: RecheckVerdicts = scopes.size ? await recheckClaims(claims.filter((c) => [...scopes.values()].flat().includes(c.id)), records, budget) : new Map();
        const outcome = applyRecheck(updated, newlyFixed, scopes, verdicts, new Date().toISOString());
        finalFlags = outcome.flags;
        const reread = newlyFixed.filter((i) => scopes.has(i)).length;
        const failures = outcome.failed.map((x) => `${flagLabel(flags[x.index])} on ${flags[x.index].key ?? "the page"}: ${x.reason}`);
        checkedNote = recheckSummary(outcome.held, outcome.total, reread, failures);
        for (const failure of failures) left.push(`The fix doesn't hold: ${failure}`);
        recheckFailed = failures.length > 0;
      } catch (error) {
        console.error("[page-fix] re-check failed:", error instanceof Error ? error.message : error);
        checkedNote = "Not re-checked: the check itself failed. Press Check to look again.";
      }
    } else if (newlyFixed.length) {
      checkedNote = "Not re-checked: the fix used up its time. Press Check to look again.";
    }
    const note = [
      done.length ? `Changed:\n${done.map((d) => `• ${d}`).join("\n")}` : answered.length ? "" : result.data.actions.length
        ? "Changed nothing." : "Changed nothing: the agent didn't say what to do. Try rewording the issue as an instruction.",
      answered.length ? `Left as is:\n${answered.map((d) => `• ${d}`).join("\n")}` : "",
      waiting.length ? `Needs a record that isn't on this page:\n${waiting.map((d) => `• ${d}`).join("\n")}` : "",
      left.length ? `Needs a person:\n${left.map((d) => `• ${d}`).join("\n")}` : "",
      lookedInto,
      checkedNote,
    ].filter(Boolean).join("\n\n");
    // Only waiting on records: nothing for a person to do now, so the page isn't sent back as needing work.
    // A fix the re-check found not holding sends the page back as needing work (its flag is open again).
    await finish(!recheckFailed && (done.length || ((waiting.length || answered.length) && !left.length)) ? "fixed" : "needs_work", note, finalFlags);
  } catch (error) {
    console.error("[page-fix]", error instanceof Error ? error.message : error);
    await finish("needs_work", budget.aborted
      ? "The agent ran out of time (about 90 seconds of model work) before it could plan the fix, and changed nothing. Press Fix again, or fix it by hand."
      : "The agent hit an error and changed nothing. Try again, or fix it by hand.");
  }
}

/** The page note's lists that settling a file_here adds to. */
type Outcome = { answered: string[]; answeredKeys: Set<string | null>; left: string[] };
type Merge = { with_matter_id: number; matter_id?: number; reason: string; key: string | null };

/**
 * file_here steps for items another topic holds. The agent compares the two topics' records (judgeTopics, the same
 * judgement the page check makes of Related topics) and, when they are the same project, merges that topic into this
 * page through the plan's merges; otherwise the entry stays a mention and the flag is answered with the reason. A
 * judgement that fails or runs out of time changes nothing and says so. (2026-11-06: the agent filed here the 2024
 * "Public Hearing Policy" item, held on its own one-item topic, and the executor left "if that topic is the same
 * project, merge it" for a person.)
 */
export async function settleHeldElsewhere(supabase: SupabaseClient, matterId: number, held: { key: string; owner: number; reason: string }[],
  merges: Merge[], signal: AbortSignal | undefined, out: Outcome): Promise<void> {
  if (!held.length) return;
  const pending: typeof held = [];
  for (const h of held) {
    // The plan already merges that topic in: the entry becomes this topic's own with it.
    const merging = merges.find((m) => !m.matter_id && m.with_matter_id === h.owner);
    if (merging) merging.key ??= h.key;
    else pending.push(h);
  }
  if (!pending.length) return;
  const owners = [...new Set(pending.map((h) => h.owner))];
  const { data: topics } = await supabase.from("matters").select("id, title, meta").in("id", owners);
  const titleOf = (id: number) => {
    const m = ((topics || []) as any[]).find((t) => t.id === id);
    return String(m?.meta?.display_title || m?.title || `topic ${id}`);
  };
  let verdicts: TopicVerdict[] | null = null;
  try {
    verdicts = await judgeTopics(supabase, matterId,
      owners.map((id) => ({ key: `related-${id}`, text: `"${titleOf(id)}", which holds ${pending.filter((h) => h.owner === id).map((h) => h.key).join(", ")} (an entry an editor wants on this page)` })),
      { shown: "shows entries that are filed on the other topics below. An editor wants them to be part of this page's "
        + "own history, which is right only if the other topic is this same project. A later review, amendment or "
        + "replacement of this page's policy, bylaw or agreement is a later step of the same project; a different policy "
        + "or bylaw that only touches the same subject is not.", signal });
  } catch (error) {
    console.error("[page-fix] comparing topics failed:", error instanceof Error ? error.message : error);
  }
  for (const h of pending) {
    const title = titleOf(h.owner);
    const v = verdicts?.find((t) => t.key === `related-${h.owner}`);
    if (!v) {
      out.left.push(`${h.reason} (that item is filed on "${title}"; comparing the two topics' records didn't finish, so nothing was merged. Press Fix again to retry.)`);
    } else if (v.verdict === "same_project") {
      const merging = merges.find((m) => !m.matter_id && m.with_matter_id === h.owner);
      if (merging) merging.key ??= h.key;
      else merges.push({ with_matter_id: h.owner, key: h.key, reason: `${h.reason} Merged "${title}" into this page: it is the same project. ${v.reason}` });
    } else {
      out.answered.push(`${h.reason} It stays a mention here: it is filed on "${title}", a separate topic. ${v.reason}`);
      out.answeredKeys.add(h.key);
    }
  }
}

/** Topics that might be this one under another name: linked as related, with the same short title, or holding an
 * item mentioned on this page that names the same bylaw as one of this topic's own items (a bylaw's adoption filed on
 * another topic shows here only as "Discussed in another item"). */
async function relatedOrSameNamed(supabase: SupabaseClient, matterId: number, alsoIds: number[] = []): Promise<Candidate[]> {
  const { data: me } = await supabase.from("matters").select("meta").eq("id", matterId).single();
  const title = (me?.meta as any)?.display_title as string | undefined;
  const bylaws = (text: string) => new Set((text.match(/\bBylaw No\.?\s*(\d{3,4})\b/gi) || []).map((b) => b.replace(/\D/g, "")));
  const [ownItems, mentions] = await Promise.all([
    fetchAll((from, to) => supabase.from("agenda_items").select("title").eq("matter_id", matterId).order("id").range(from, to)),
    fetchAll((from, to) => supabase.from("matter_links").select("agenda_items(matter_id, title)").eq("matter_id", matterId).eq("kind", "mention").eq("hidden", false).order("id").range(from, to)),
  ]);
  const mine = new Set(((ownItems || []) as any[]).flatMap((i) => [...bylaws(String(i.title || ""))]));
  const sameBylaw = ((mentions || []) as any[]).map((l) => (Array.isArray(l.agenda_items) ? l.agenda_items[0] : l.agenda_items))
    .filter((i) => i?.matter_id && i.matter_id !== matterId && [...bylaws(String(i.title || ""))].some((b) => mine.has(b)))
    .map((i) => i.matter_id as number);
  const [{ data: links }, { data: named }, sameSite] = await Promise.all([
    supabase.from("matter_links").select("matter_id, related_matter_id").eq("kind", "related_matter").eq("hidden", false)
      .or(`matter_id.eq.${matterId},related_matter_id.eq.${matterId}`),
    title ? supabase.from("matters").select("id").eq("meta->>display_title", title).neq("id", matterId).limit(10) : Promise.resolve({ data: [] }),
    sameSiteTopics(supabase, matterId),
  ]);
  const sameSiteIds = new Set(sameSite.map((m) => m.id));
  const ids = [...new Set([...(links || []).map((l: any) => (l.matter_id === matterId ? l.related_matter_id : l.matter_id)),
    ...((named || []) as any[]).map((m) => m.id), ...sameBylaw, ...sameSiteIds, ...alsoIds])].filter((id) => id !== matterId);
  if (!ids.length) return [];
  const relatedIds = new Set((links || []).map((l: any) => (l.matter_id === matterId ? l.related_matter_id : l.matter_id)));
  const owners = new Set(alsoIds);
  const { data } = await supabase.from("matters").select("id, title, meta, first_seen, last_seen").in("id", ids)
    .is("merged_into", null);
  return (data || []).map((m: any) => ({ id: m.id, title: m.meta?.display_title || m.title,
    dates: [m.first_seen, m.last_seen].filter(Boolean).join(" to "), related: relatedIds.has(m.id), sameSite: sameSiteIds.has(m.id),
    // A bundle topic (a meeting's committee resolutions) holds other subjects too: never a merge candidate for that.
    owner: owners.has(m.id) && m.meta?.hidden !== "container" }));
}

/** The topics holding the items staff accepted for this page: entries just added from the search, and mentions
 * staff accepted earlier (matter_links review "accepted"). At most eight, newest links first. */
async function acceptedOwners(supabase: SupabaseClient, matterId: number, justAdded: number[]): Promise<number[]> {
  const { data: links } = await supabase.from("matter_links").select("agenda_item_id").eq("matter_id", matterId)
    .eq("kind", "mention").eq("hidden", false).eq("review", "accepted").order("id", { ascending: false }).limit(20);
  const items = [...new Set([...justAdded, ...((links || []) as any[]).map((l) => l.agenda_item_id).filter(Boolean)])];
  if (!items.length) return [];
  const { data } = await supabase.from("agenda_items").select("matter_id").in("id", items);
  return [...new Set(((data || []) as any[]).map((i) => i.matter_id).filter((id) => id && id !== matterId))].slice(0, 8);
}
