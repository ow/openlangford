import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { getAiClient } from "./ai/index.server";
import { renderPage } from "../lib/page-render.server";
import { FLAG_PROBLEM_LABELS, type PageFlag } from "../lib/page-review-types";
import { readPage } from "./page-check.server";
import { matterForPath, removableKey, removeEntry } from "./page-links.server";
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
    action: z.enum(["remove_entry", "move_item", "unfile_item", "rewrite_entry", "rewrite_heading", "rewrite_summary", "merge_topic", "cannot_fix"]),
    key: z.string().nullable().describe("The entry's key exactly as given, or null."),
    to_matter_id: z.number().int().nullable().describe("move_item: a candidate topic's id, or null to have it re-filed the way new meetings are filed (never back here). merge_topic: the duplicate topic's id. Otherwise null."),
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

function planPrompt(heading: string, entries: { key: string; text: string }[], flags: PageFlag[], note: string | null,
  candidates: Map<string, Candidate[]>, records: string, lookalikes: Candidate[] = []) {
  const removable = entries.filter((e) => removableKey(e.key)).map((e) => e.key);
  const movable = [...candidates.entries()].map(([key, list]) =>
    `- [${key}] could move to: ${list.length ? list.map((c) => `${c.id} "${c.title}"${c.dates ? ` (${c.dates})` : ""}`).join("; ") : "no listed topic (move_item with null re-files it)"}`).join("\n");
  return `You fix problems on a page of Open Langford, a site that follows Langford City council. An editor
reviewed the page "${heading}" and agreed these problems are real:
${flags.map((f) => `- [${f.key ?? "whole page"}] ${FLAG_PROBLEM_LABELS[f.problem]}: ${f.reason}${f.fix ? `\n  Approved fix (do this): ${f.fix}` : ""}${f.note ? `\n  Editor's instruction for this entry (follow it, over the fix above): ${f.note}` : ""}`).join("\n")}
${note ? `\nTheir note: ${note}\n` : ""}
What you can do:
- remove_entry: drop a link found for this topic (${removable.join(", ") || "none here"}). Removing a "background-" entry
  unlinks the whole related topic it came from, so prefer rewrite_entry or rewrite_heading when only its wording is wrong.
- move_item: an item filed under this topic ("agenda-") or a linked mention ("mention-") that belongs to another topic.
  Pick a listed candidate when it clearly fits; otherwise to_matter_id null, and it is re-filed the way new meetings
  are filed (onto the topic for its own address or permit, or a new one), never back here.
- unfile_item: only for an "agenda-" item that isn't a topic of its own at all (a section heading, a one-off courtesy item).
${movable || "(No flagged items to move.)"}
- rewrite_entry: a new line for any entry ("agenda-", "mention-", "background-", "report-"): one plain sentence of at most
  140 characters saying what this step did for this topic, outcome first ("Council gave second and third reading to the
  rezoning for the 165-home Costin Avenue apartments"). Use only facts in the records below; no file numbers, bylaw
  numbers or jargon unless the record gives nothing else.
- rewrite_heading: a new heading for a "mention-", "background-" or "report-" entry whose heading is wrong or misleading.
- rewrite_summary: for the topic's summary or "where it stands", a short instruction for the summary writer in new_text.
- merge_topic: when a related or same-named topic below is the very same project as this page (a duplicate, not just an
  earlier or later step), with its id.
${lookalikes.length ? `Related and same-named topics:\n${lookalikes.map((c) => `- ${c.id} "${c.title}"${c.dates ? ` (${c.dates})` : ""}`).join("\n")}\n` : ""}
Every rewrite (entry, heading or summary) puts the records' own words it rests on in "source", quoted exactly. A
"Not backed by the record" problem quotes what the record says: fix it by rewriting to what the record supports.
An entry with the wrong date usually means the record itself is filed at the wrong meeting: rewrite its line to state
the right date with the quote that gives it, or, if no record gives the right date, say cannot_fix and name exactly
which record and which date disagree. Use cannot_fix only when none of these actions can make the page right, and say
precisely what is wrong and where, not "a person should look".

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
    const { data: row } = await supabase.from("page_reviews").select("ai_flags, note").eq("path", path).maybeSingle();
    const flags = ((row?.ai_flags || []) as PageFlag[]);
    const agreed = flags.filter((f) => f.verdict === "agree" && !f.fixed);
    const matterId = await matterForPath(supabase, path);
    if (!matterId) return finish("needs_work", "The agent only fixes topic pages so far. This one needs a person.");
    if (!agreed.length && !row?.note) return finish("needs_work", "Nothing to fix: no flags were rated 👍 and there's no note.");

    const page = readPage(await renderPage(origin, path));
    const itemId = (key: string | null | undefined) => Number(key?.match(/^(?:agenda|mention|background)-(\d+)$/)?.[1] ?? NaN);
    const movableKey = (key: string | null | undefined) => !!key && /^(agenda|mention)-\d+$/.test(key);
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
    const lookalikes = await relatedOrSameNamed(supabase, matterId);
    const result = await getAiClient().json({
      stage: "review",
      prompt: planPrompt(page.heading || page.title, page.entries, agreed, row?.note ?? null, candidates, records, lookalikes),
      schema: PlanSchema,
      schemaName: "page_fix_plan",
    });

    const onPage = new Set(page.entries.map((e) => e.key));
    const done: string[] = [];
    const left: string[] = [];
    const fixedKeys = new Set<string>();
    const moves: { item_id: number; to_matter_id: number | null; refile?: boolean; reason: string }[] = [];
    const mentionMoves: { item_id: number; to_matter_id: number; reason: string }[] = [];
    const merges: { with_matter_id: number; reason: string }[] = [];
    const rewrites: Record<string, string> = {};
    const lines: Record<string, { line?: string; heading?: string; source?: string }> = {};
    const summaryNotes: string[] = [];
    const quoteOf = (step: { source: string | null }) => (step.source || "").replace(/\s+/g, " ").trim().slice(0, 600);
    for (const step of result.data.actions) {
      if (step.action === "merge_topic" && step.to_matter_id && lookalikes.some((c) => c.id === step.to_matter_id)) {
        merges.push({ with_matter_id: step.to_matter_id, reason: step.reason });
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
          left.push(`${step.reason} (no record was quoted to support the new wording, so nothing changed)`);
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
        if (step.to_matter_id !== null && !offered) {
          left.push(`${step.reason} (the agent picked a topic that wasn't offered, so nothing moved)`);
        } else if (step.key!.startsWith("agenda-")) {
          moves.push({ item_id: itemId(step.key), to_matter_id: step.to_matter_id, refile: step.to_matter_id === null, reason: step.reason });
        } else if (step.to_matter_id !== null) {
          mentionMoves.push({ item_id: itemId(step.key), to_matter_id: step.to_matter_id, reason: step.reason });
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
        left.push(step.reason);
      }
    }
    for (const move of mentionMoves) {
      // The link is re-pointed, not dropped: the mention now shows on the topic it's about.
      const { data: moved, error } = await supabase.from("matter_links").update({ matter_id: move.to_matter_id })
        .eq("matter_id", matterId).eq("agenda_item_id", move.item_id).eq("kind", "mention").select("id");
      if (error || !moved?.length) {
        left.push(`${move.reason} (it didn't work: the link couldn't be moved)`);
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
      ? { ...f, fixed: true } : f);
    if (moves.length || merges.length || done.length) {
      // The pipeline's quick worker moves items and rewrites the changed summaries, then finishes the page.
      const { data: municipality } = await supabase.from("municipalities").select("id").order("id").limit(1).maybeSingle();
      const { error } = await supabase.from("pipeline_jobs").insert({
        municipality_id: municipality?.id ?? 1, job_type: "fix_page", requested_by: requester.id, max_attempts: 1,
        args: { path, moves, merges: merges.map((m) => ({ ...m, matter_id: matterId })), refresh: [matterId], done, left,
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
      left.length ? `Needs a person:\n${left.map((d) => `• ${d}`).join("\n")}` : "",
    ].filter(Boolean).join("\n\n");
    await finish(done.length ? "fixed" : "needs_work", note, updated);
  } catch (error) {
    console.error("[page-fix]", error instanceof Error ? error.message : error);
    await finish("needs_work", "The agent hit an error and changed nothing. Try again, or fix it by hand.");
  }
}

/** Topics that might be this one under another name: linked as related, or with the same short title. */
async function relatedOrSameNamed(supabase: SupabaseClient, matterId: number): Promise<Candidate[]> {
  const { data: me } = await supabase.from("matters").select("meta").eq("id", matterId).single();
  const title = (me?.meta as any)?.display_title as string | undefined;
  const [{ data: links }, { data: named }] = await Promise.all([
    supabase.from("matter_links").select("matter_id, related_matter_id").eq("kind", "related_matter").eq("hidden", false)
      .or(`matter_id.eq.${matterId},related_matter_id.eq.${matterId}`),
    title ? supabase.from("matters").select("id").eq("meta->>display_title", title).neq("id", matterId).limit(10) : Promise.resolve({ data: [] }),
  ]);
  const ids = [...new Set([...(links || []).map((l: any) => (l.matter_id === matterId ? l.related_matter_id : l.matter_id)),
    ...((named || []) as any[]).map((m) => m.id)])];
  if (!ids.length) return [];
  const { data } = await supabase.from("matters").select("id, title, meta, first_seen, last_seen").in("id", ids)
    .is("meta->>canonical_matter_id", null);
  return (data || []).map((m: any) => ({ id: m.id, title: m.meta?.display_title || m.title,
    dates: [m.first_seen, m.last_seen].filter(Boolean).join(" to ") }));
}
