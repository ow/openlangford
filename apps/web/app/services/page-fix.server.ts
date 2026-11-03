import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { getAiClient } from "./ai/index.server";
import { renderPage } from "../lib/page-render.server";
import { FLAG_PROBLEM_LABELS, type PageFlag } from "../lib/page-review-types";
import { readPage } from "./page-check.server";
import { decideSuggestion, listSuggestions, matterForPath, removableKey, removeEntry, setTopicHidden, type Suggestion } from "./page-links.server";
import { itemRecords } from "./page-verify.server";
import { logStaffAction } from "./staff.server";
import type { StaffRole } from "../lib/auth.server";

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
 * it the way ingest would when no listed topic fits (a fix_page job on the pipeline's quick worker, which also
 * rewrites the summaries of the topics whose timelines changed and checks that each summary instruction was followed).
 * Every rewrite carries the record's words it rests on.
 */

const PlanSchema = z.object({
  actions: z.array(z.object({
    action: z.enum(["remove_entry", "move_item", "unfile_item", "file_here", "hide_duplicate", "rewrite_entry", "rewrite_heading",
      "rewrite_summary", "merge_topic", "accept_suggestion", "hide_page", "cannot_fix"]),
    key: z.string().nullable().describe("The entry's key exactly as given, or null."),
    keep_key: z.string().nullable().describe("hide_duplicate: the key of the entry that stays (it already says what this one says). Otherwise null."),
    to_matter_id: z.number().int().nullable().describe("move_item: a candidate topic's id, or null to have it re-filed the way new meetings are filed (never back here). merge_topic: the duplicate topic's id. Otherwise null."),
    other_matter_id: z.number().int().nullable().describe("merge_topic only, when two related topics below duplicate each other but not this page: the second one's id (to_matter_id is the first). Otherwise null."),
    new_text: z.string().nullable().describe("rewrite_entry: the entry's new one-line description for this topic. rewrite_heading: the entry's new heading. rewrite_summary: the instruction for the summary writer. Otherwise null."),
    source: z.string().nullable().describe("rewrite_summary / rewrite_entry / rewrite_heading: the record's own words that support the change, quoted exactly from the records above. The summary writer only sees the topic's timeline, so without this quote it can't follow the instruction. Null otherwise."),
    reason: z.string().describe("One plain sentence a resident would understand: what you're doing and why, or why it can't be done."),
  })),
});

type Candidate = { id: number; title: string; dates: string };

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
    .is("meta->>canonical_matter_id", null).is("meta->>hidden", null);
  return ((data || []) as any[]).sort((a, b) => (ids.get(a.id)! - ids.get(b.id)!)).slice(0, 8).map((m) => ({
    id: m.id, title: m.meta?.display_title || m.title, dates: [m.first_seen, m.last_seen].filter(Boolean).join(" to "),
  }));
}

/** A search suggestion's key for the agent: "suggestion-L12" (a meeting item or topic link) or "suggestion-R7" (a report page). */
const suggestionKey = (s: Suggestion) => `suggestion-${s.table === "matter_links" ? "L" : "R"}${s.id}`;

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

function planPrompt(heading: string, entries: { key: string; text: string }[], flags: PageFlag[], note: string | null,
  candidates: Map<string, Candidate[]>, records: string, lookalikes: Candidate[] = [], suggestions: Suggestion[] = [],
  internalNote: string | null = null) {
  const removable = entries.filter((e) => removableKey(e.key)).map((e) => e.key);
  const movable = [...candidates.entries()].map(([key, list]) =>
    `- [${key}] could move to: ${list.length ? list.map((c) => `${c.id} "${c.title}"${c.dates ? ` (${c.dates})` : ""}`).join("; ") : "no listed topic (move_item with null re-files it)"}`).join("\n");
  return `You fix problems on a page of Open Langford, a site that follows Langford City council. An editor
reviewed the page "${heading}" and agreed these problems are real:
${flags.map((f) => `- [${f.key ?? "whole page"}] ${FLAG_PROBLEM_LABELS[f.problem]}: ${f.reason}${f.fix ? `\n  Approved fix (do this): ${f.fix}` : ""}${f.note ? `\n  Editor's instruction for this entry (follow it, over the fix above): ${f.note}` : ""}`).join("\n")}
${note ? `\nTheir note: ${note}\n` : ""}${internalNote ? `\nStaff's internal note on this page (background to keep in mind, not an instruction): ${internalNote}\n` : ""}
What you can do:
- remove_entry: drop a link found for this topic (${removable.join(", ") || "none here"}). Removing a "background-" entry
  unlinks the whole related topic it came from, so prefer rewrite_entry or rewrite_heading when only its wording is wrong.
- move_item: an item filed under this topic ("agenda-") or a linked mention ("mention-") that belongs to another topic.
  Pick a listed candidate when it clearly fits; otherwise to_matter_id null, and it is re-filed the way new meetings
  are filed (onto the topic for its own address or permit, or a new one), never back here.
- unfile_item: only for an "agenda-" item that isn't a topic of its own at all (a section heading, a one-off courtesy item).
${movable || "(No flagged items to move.)"}
- hide_duplicate: an "agenda-" entry that repeats another entry on this page (the same step recorded twice, e.g. a staff
  report and the bylaw readings at one meeting): give keep_key, the entry that stays. It is hidden from the timeline,
  not deleted, and stays part of the topic.
- file_here: a "mention-" entry that is really one of this topic's own steps (e.g. the bylaw's adoption shown only as
  "Discussed in another item"). It becomes part of this topic's own history, so the summary can rely on it. Only when the item
  isn't filed on another topic; if it is, that other topic is probably the same project (merge_topic) or this page
  holds items that belong there (move_item).
- rewrite_entry: a new line for any entry ("agenda-", "mention-", "background-", "report-"): one plain sentence of at most
  140 characters saying what this step did for this topic, outcome first ("Council gave second and third reading to the
  rezoning for the 165-home Costin Avenue apartments"). Use only facts in the records below; no file numbers, bylaw
  numbers or jargon unless the record gives nothing else.
- rewrite_heading: a new heading for a "mention-", "background-" or "report-" entry whose heading is wrong or misleading.
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
- accept_suggestion: add one of the entries the search found for this page (listed below, not yet on it) when it
  supplies what an agreed problem says is missing (e.g. the adoption or decision the status lacks), with its key.
  A meeting item accepted here appears as "Discussed in another item"; if it is this topic's own step, the summary still won't
  rely on it, so say so in the reason and the editor can file it here.
${suggestions.length ? `Entries the search found, waiting for a decision:\n${suggestions.map((x) => `- [${suggestionKey(x)}] ${x.date ?? ""} ${x.title}${x.quote ? `: "${x.quote.slice(0, 240)}"` : ""}${x.reason ? ` (found because: ${x.reason})` : ""}`).join("\n")}\n` : ""}${lookalikes.length ? `Related and same-named topics:\n${lookalikes.map((c) => `- ${c.id} "${c.title}"${c.dates ? ` (${c.dates})` : ""}`).join("\n")}\n` : ""}
Every rewrite (entry, heading or summary) puts the records' own words it rests on in "source", quoted exactly. A
"Not backed by the record" problem quotes what the record says: fix it by rewriting to what the record supports.
An entry with the wrong date usually means the record itself is filed at the wrong meeting: rewrite its line to state
the right date with the quote that gives it, or, if no record gives the right date, say cannot_fix and name exactly
which record and which date disagree. Work only from the records above, and never wait for more. When they don't
say something, fix with what they do say: rewrite the line or summary to what they support (or to say plainly what
they leave out), remove an entry they can't tie to this topic, and leave an entry that is about it as it is.
- hide_page: when nothing in the records backs this page at all (no step of its own, nothing showing what it's
  about), hide it from the public. It can be undone, and the editor confirms it like every other change.
Use cannot_fix only for a genuine judgement call none of these actions can make, and say precisely what is wrong and
where, not "a person should look".

For each agreed problem (and anything the note asks), give one action. Don't change anything the editor didn't
agree with or ask for.

Records (each item's motions, reports and minutes; "MINUTES OR REPORT TEXT FROM THIS MEETING" was found in the same
meeting's minutes or reports by the item's subject):
${records || "(none)"}

Timeline entries:
${entries.map((e) => `[${e.key}] ${e.text}`).join("\n\n")}`;
}

/** Runs the agent for one page. Never throws: a failure is written to the page as "needs work" with a note. */
export async function fixPage(supabase: SupabaseClient, origin: string, path: string, requester: { id: string; staffRole: StaffRole }) {
  const finish = async (status: "fixed" | "needs_work", agent_note: string, flags?: PageFlag[]) => {
    await supabase.from("page_reviews").update({
      status, agent_note, agent_at: new Date().toISOString(), ...(flags ? { ai_flags: flags } : {}),
    }).eq("path", path);
  };
  try {
    const { data: row } = await supabase.from("page_reviews").select("ai_flags, note, internal_note").eq("path", path).maybeSingle();
    const flags = ((row?.ai_flags || []) as PageFlag[]);
    const agreed = flags.filter((f) => f.verdict === "agree" && !f.fixed);
    const matterId = await matterForPath(supabase, path);
    if (!matterId) return finish("needs_work", "The agent only fixes topic pages so far. This one needs a person.");
    // Entries the search found that staff rated 👍: added first, so the plan (and the one summary rewrite) sees them.
    const agreedFound = (await listSuggestions(supabase, matterId).catch(() => [] as Suggestion[])).filter((x) => x.agreed);
    if (!agreed.length && !row?.note && !agreedFound.length) {
      // Everything agreed is already fixed (perhaps by a run a moment ago): back to "fixed", as that run left it
      // (returning without that would leave the page saying the agent is still working).
      if (flags.some((f) => f.verdict === "agree" && f.fixed)) {
        await supabase.from("page_reviews").update({ status: "fixed" }).eq("path", path);
        return;
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
    // The records behind the page: every item filed here plus each flagged linked item, gathered the way the page
    // check gathers them (unattached minutes and reports of the same meeting included), and flagged report quotes.
    const { data: own } = await supabase.from("agenda_items").select("id").eq("matter_id", matterId).limit(60);
    const ids = [...new Set([...((own || []) as any[]).map((i) => i.id), ...agreed.map((f) => itemId(f.key)).filter(Number.isSafeInteger)])];
    const reportIds = agreed.map((f) => Number(f.key?.match(/^report-(\d+)$/)?.[1] ?? NaN)).filter(Number.isSafeInteger);
    const [{ text: itemText }, { data: reports }] = await Promise.all([
      itemRecords(supabase, ids),
      reportIds.length ? supabase.from("matter_report_mentions").select("id, page, quote").in("id", reportIds) : Promise.resolve({ data: [] }),
    ]);
    const records = [itemText, ...((reports || []) as any[]).map((r) => `REPORT ENTRY report-${r.id} (annual report page ${r.page}): ${r.quote}`)]
      .filter(Boolean).join("\n\n");
    const [lookalikes, suggestions] = await Promise.all([relatedOrSameNamed(supabase, matterId),
      listSuggestions(supabase, matterId).catch(() => [] as Suggestion[])]);
    const result = await getAiClient().json({
      stage: "review",
      prompt: planPrompt(page.heading || page.title, page.entries, agreed, [row?.note, addedNote].filter(Boolean).join("\n\n") || null, candidates, records, lookalikes, suggestions,
        (row as { internal_note?: string | null } | null)?.internal_note ?? null),
      schema: PlanSchema,
      schemaName: "page_fix_plan",
    });

    const onPage = new Set(page.entries.map((e) => e.key));
    const done: string[] = added.length
      ? [`Added ${added.length === 1 ? "the entry" : `${added.length} entries`} the search found: ${added.map((a) => a.title).join("; ")}.`] : [];
    const left: string[] = [];
    const fixedKeys = new Set<string>();
    const moves: { item_id: number; to_matter_id: number | null; refile?: boolean; reason: string }[] = [];
    const mentionMoves: { item_id: number; to_matter_id: number; reason: string }[] = [];
    const merges: { with_matter_id: number; matter_id?: number; reason: string }[] = [];
    const rewrites: Record<string, string> = {};
    const lines: Record<string, { line?: string; heading?: string; source?: string }> = {};
    const summaryNotes: string[] = [];
    const waiting: string[] = [];
    const hidden: Record<string, { keep: number; reason: string; by: string; at: string }> = {};
    const quoteOf = (step: { source: string | null }) => (step.source || "").replace(/\s+/g, " ").trim().slice(0, 600);
    for (const step of result.data.actions) {
      if (step.action === "merge_topic" && step.to_matter_id && lookalikes.some((c) => c.id === step.to_matter_id)) {
        const other = step.other_matter_id && step.other_matter_id !== step.to_matter_id
          && lookalikes.some((c) => c.id === step.other_matter_id) ? step.other_matter_id : null;
        // Two related topics merged with each other, or one merged into this page.
        merges.push(other ? { matter_id: other, with_matter_id: step.to_matter_id, reason: step.reason }
          : { with_matter_id: step.to_matter_id, reason: step.reason });
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
            done.push(step.reason);
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
          done.push(step.reason);
        }
        continue;
      }
      if (step.action === "file_here" && step.key?.startsWith("mention-") && onPage.has(step.key)) {
        const { data: item } = await supabase.from("agenda_items").select("matter_id, meta").eq("id", itemId(step.key)).maybeSingle();
        const lock = (item?.meta as any)?.staff_matter;
        if (!item) left.push(`${step.reason} (that item couldn't be found)`);
        else if (lock && "matter_id" in lock && lock.matter_id !== matterId) left.push(`${step.reason} (an editor placed that item ${lock.matter_id ? `on topic ${lock.matter_id}` : "off every topic"}, so it stays there)`);
        else if (item.matter_id && item.matter_id !== matterId) left.push(`${step.reason} (that item is filed on topic ${item.matter_id}; if that topic is the same project, merge it, otherwise it stays there)`);
        else {
          moves.push({ item_id: itemId(step.key), to_matter_id: matterId, reason: step.reason });
          fixedKeys.add(step.key);
        }
        continue;
      }
      if (step.action === "rewrite_summary" && (step.new_text || "").trim()) {
        const quote = quoteOf(step);
        summaryNotes.push(`${(step.new_text || "").trim().slice(0, 500)}${quote ? ` The record says: “${quote}”` : ""}`);
        done.push(`${step.reason} The summary is being rewritten with this note: "${(step.new_text || "").trim()}"`);
        continue;
      }
      if ((step.action === "rewrite_entry" || step.action === "rewrite_heading") && step.key && onPage.has(step.key)
          && /^(agenda|mention|background|report)-\d+$/.test(step.key)) {
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
          done.push(`${step.reason} New ${heading ? "heading" : "line"}: "${text}"`);
        }
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
            done.push(step.reason);
          } catch (error) {
            left.push(`${step.reason} (it didn't work: ${error instanceof Error ? error.message : "unknown error"})`);
          }
        }
        continue;
      }
      if (step.action === "remove_entry" && step.key && removableKey(step.key) && onPage.has(step.key) && !fixedKeys.has(step.key)) {
        try {
          await removeEntry(supabase, matterId, step.key, requester.id);
          fixedKeys.add(step.key);
          done.push(step.reason);
          await logStaffAction(supabase, {
            userId: requester.id, role: requester.staffRole, path, action: "agent:remove_entry",
            detail: { key: step.key, reason: step.reason.slice(0, 400) },
          });
        } catch (error) {
          left.push(`${step.reason} (it didn't work: ${error instanceof Error ? error.message : "unknown error"})`);
        }
      } else {
        const why = step.action === "cannot_fix" ? "" : step.key && !onPage.has(step.key) ? " (that entry isn't on the page any more)"
          : " (that action doesn't apply to this entry)";
        left.push(`${step.reason}${why}`);
      }
    }
    for (const move of mentionMoves) {
      // The link is re-pointed, not dropped: the mention now shows on the topic it's about.
      const { data: moved, error } = await supabase.from("matter_links").update({ matter_id: move.to_matter_id })
        .eq("matter_id", matterId).eq("agenda_item_id", move.item_id).eq("kind", "mention").select("id");
      if (error || !moved?.length) {
        // Usually the other topic already links that item (or holds it): then it only needs to come off this page.
        try {
          await removeEntry(supabase, matterId, `mention-${move.item_id}`, requester.id);
          fixedKeys.add(`mention-${move.item_id}`);
          done.push(move.reason);
        } catch {
          left.push(`${move.reason} (it didn't work: the link couldn't be moved or removed)`);
        }
        continue;
      }
      fixedKeys.add(`mention-${move.item_id}`);
      done.push(move.reason);
      await logStaffAction(supabase, { userId: requester.id, role: requester.staffRole, path, action: "agent:move_mention",
        detail: { agenda_item_id: String(move.item_id), from: String(matterId), to: String(move.to_matter_id), reason: move.reason.slice(0, 400) } });
    }
    if (Object.keys(rewrites).length || Object.keys(lines).length) {
      const { data: matter } = await supabase.from("matters").select("meta").eq("id", matterId).single();
      const meta = (matter?.meta || {}) as Record<string, any>;
      const entryLines = { ...(meta.entry_lines || {}) };
      for (const [key, value] of Object.entries(lines)) entryLines[key] = { ...(entryLines[key] || {}), ...value };
      const { error } = await supabase.from("matters").update({ meta: {
        ...meta,
        timeline_headlines: { ...(meta.timeline_headlines || {}), ...rewrites },
        staff_headlines: { ...(meta.staff_headlines || {}), ...rewrites },
        ...(Object.keys(lines).length ? { entry_lines: entryLines } : {}),
      } }).eq("id", matterId);
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
    if (summaryNotes.length) {
      // Kept on the topic: every later summary rewrite follows them too (pipeline matter_summaries).
      const { data: matter } = await supabase.from("matters").select("meta").eq("id", matterId).single();
      const meta = (matter?.meta || {}) as Record<string, any>;
      await supabase.from("matters").update({ meta: { ...meta, editor_notes: [...(meta.editor_notes || []), ...summaryNotes].slice(-10) } })
        .eq("id", matterId);
      await logStaffAction(supabase, { userId: requester.id, role: requester.staffRole, path, action: "agent:rewrite_summary",
        detail: { notes: summaryNotes.join(" | ").slice(0, 500) } });
    }
    // Any agreed flag on an entry that's now gone is resolved, whichever step removed it; a whole-page issue is
    // resolved by a summary rewrite.
    const updated = flags.map((f) => (f.key && fixedKeys.has(f.key)) || (!f.key && f.verdict === "agree" && summaryNotes.length)
      ? { ...f, key: renamed.get(f.key!) ?? f.key, fixed: true } : { ...f, key: renamed.get(f.key!) ?? f.key });
    if (moves.length || merges.length || done.length) {
      // The pipeline's quick worker moves items and rewrites the changed summaries, then finishes the page.
      const { data: municipality } = await supabase.from("municipalities").select("id").order("id").limit(1).maybeSingle();
      const { error } = await supabase.from("pipeline_jobs").insert({
        municipality_id: municipality?.id ?? 1, job_type: "fix_page", requested_by: requester.id, max_attempts: 1,
        args: { path, moves, merges: merges.map((m) => ({ ...m, matter_id: m.matter_id ?? matterId })), refresh: [matterId], done, left, waiting,
          summary_notes: summaryNotes.map((note) => ({ matter_id: matterId, note })),
          requested_by: requester.id, role: requester.staffRole },
      });
      if (!error) {
        await supabase.from("page_reviews").update({
          ai_flags: updated, agent_at: new Date().toISOString(),
          agent_note: [done.length ? `Done so far:\n${done.map((d) => `• ${d}`).join("\n")}` : "",
            `Next, on the pipeline worker: ${moves.length ? `move ${moves.length} ${moves.length === 1 ? "item" : "items"}, then ` : ""}${merges.length ? `merge ${merges.length} duplicate ${merges.length === 1 ? "topic" : "topics"}, then ` : ""}rewrite the summary${summaryNotes.length ? " and check it follows the instructions" : ""}.`]
            .filter(Boolean).join("\n\n"),
        }).eq("path", path);
        return;
      }
      left.push("Couldn't hand the rest to the pipeline worker, so items weren't moved and the summary wasn't rewritten.");
    }
    const note = [
      done.length ? `Changed:\n${done.map((d) => `• ${d}`).join("\n")}` : "Changed nothing.",
      waiting.length ? `Needs a record that isn't on this page:\n${waiting.map((d) => `• ${d}`).join("\n")}` : "",
      left.length ? `Needs a person:\n${left.map((d) => `• ${d}`).join("\n")}` : "",
    ].filter(Boolean).join("\n\n");
    // Only waiting on records: nothing for a person to do now, so the page isn't sent back as needing work.
    await finish(done.length || (waiting.length && !left.length) ? "fixed" : "needs_work", note, updated);
  } catch (error) {
    console.error("[page-fix]", error instanceof Error ? error.message : error);
    await finish("needs_work", "The agent hit an error and changed nothing. Try again, or fix it by hand.");
  }
}

/** Topics that might be this one under another name: linked as related, with the same short title, or holding an
 * item mentioned on this page that names the same bylaw as one of this topic's own items (a bylaw's adoption filed on
 * another topic shows here only as "Discussed in another item"). */
async function relatedOrSameNamed(supabase: SupabaseClient, matterId: number): Promise<Candidate[]> {
  const { data: me } = await supabase.from("matters").select("meta").eq("id", matterId).single();
  const title = (me?.meta as any)?.display_title as string | undefined;
  const bylaws = (text: string) => new Set((text.match(/\bBylaw No\.?\s*(\d{3,4})\b/gi) || []).map((b) => b.replace(/\D/g, "")));
  const [{ data: ownItems }, { data: mentions }] = await Promise.all([
    supabase.from("agenda_items").select("title").eq("matter_id", matterId).limit(60),
    supabase.from("matter_links").select("agenda_items(matter_id, title)").eq("matter_id", matterId).eq("kind", "mention").eq("hidden", false).limit(80),
  ]);
  const mine = new Set(((ownItems || []) as any[]).flatMap((i) => [...bylaws(String(i.title || ""))]));
  const sameBylaw = ((mentions || []) as any[]).map((l) => (Array.isArray(l.agenda_items) ? l.agenda_items[0] : l.agenda_items))
    .filter((i) => i?.matter_id && i.matter_id !== matterId && [...bylaws(String(i.title || ""))].some((b) => mine.has(b)))
    .map((i) => i.matter_id as number);
  const [{ data: links }, { data: named }] = await Promise.all([
    supabase.from("matter_links").select("matter_id, related_matter_id").eq("kind", "related_matter").eq("hidden", false)
      .or(`matter_id.eq.${matterId},related_matter_id.eq.${matterId}`),
    title ? supabase.from("matters").select("id").eq("meta->>display_title", title).neq("id", matterId).limit(10) : Promise.resolve({ data: [] }),
  ]);
  const ids = [...new Set([...(links || []).map((l: any) => (l.matter_id === matterId ? l.related_matter_id : l.matter_id)),
    ...((named || []) as any[]).map((m) => m.id), ...sameBylaw])];
  if (!ids.length) return [];
  const { data } = await supabase.from("matters").select("id, title, meta, first_seen, last_seen").in("id", ids)
    .is("meta->>canonical_matter_id", null);
  return (data || []).map((m: any) => ({ id: m.id, title: m.meta?.display_title || m.title,
    dates: [m.first_seen, m.last_seen].filter(Boolean).join(" to ") }));
}
