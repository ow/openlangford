import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { getAiClient } from "./ai/index.server";
import { renderPage } from "../lib/page-render.server";
import { FLAG_PROBLEM_LABELS, type PageFlag } from "../lib/page-review-types";
import { readPage } from "./page-check.server";
import { matterForPath, removableKey, removeEntry } from "./page-links.server";
import { logStaffAction } from "./staff.server";
import type { StaffRole } from "../lib/auth.server";

/**
 * The fix agent. Marking a page "needs work" starts it on the server: it reads the flags staff agreed with (👍)
 * and their note, plans fixes from a fixed menu, carries them out, and leaves the page "fixed" for staff to
 * confirm, with a note of what it changed and what it couldn't do. Every change is recorded in staff_actions under
 * the person who asked, tagged as the agent's.
 *
 * It can remove a timeline entry found for the topic or unlink the related topic an entry came from (here, at
 * once), rewrite the one-line description an entry has on this topic (matters.meta.timeline_headlines, kept through
 * later summary rewrites as meta.staff_headlines) from the item's own record, and move an item filed under the wrong topic to the right one, or off every topic (a fix_page job on the
 * pipeline's quick worker, which also rewrites the summaries of the topics whose timelines changed).
 */

const PlanSchema = z.object({
  actions: z.array(z.object({
    action: z.enum(["remove_entry", "move_item", "rewrite_entry", "rewrite_summary", "merge_topic", "cannot_fix"]),
    key: z.string().nullable().describe("The entry's key exactly as given, or null."),
    to_matter_id: z.number().int().nullable().describe("move_item: a candidate topic's id, or null to take the item off every topic. merge_topic: the duplicate topic's id."),
    new_text: z.string().nullable().describe("rewrite_entry: the entry's new one-line description for this topic. rewrite_summary: the instruction for the summary writer. Otherwise null."),
    reason: z.string().describe("One plain sentence a resident would understand: what you're doing and why, or why it can't be done."),
  })),
});

type Candidate = { id: number; title: string; dates: string };

/** Topics an item filed here might belong to instead: full-text matches on its title, not this topic. */
async function candidatesFor(supabase: SupabaseClient, matterId: number, title: string): Promise<Candidate[]> {
  const words = title.replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter((w) => w.length > 3).slice(0, 8).join(" or ");
  if (!words) return [];
  const { data } = await supabase.from("matters").select("id, title, meta, first_seen, last_seen")
    .textSearch("text_search", words, { type: "websearch", config: "english" })
    .is("meta->>canonical_matter_id", null).neq("id", matterId).limit(6);
  return (data || []).map((m: any) => ({
    id: m.id, title: m.meta?.display_title || m.title, dates: [m.first_seen, m.last_seen].filter(Boolean).join(" to "),
  }));
}

function planPrompt(heading: string, entries: { key: string; text: string }[], flags: PageFlag[], note: string | null,
  candidates: Map<string, Candidate[]>, records: Map<string, string>, lookalikes: Candidate[] = []) {
  const removable = entries.filter((e) => removableKey(e.key)).map((e) => e.key);
  const movable = [...candidates.entries()].map(([key, list]) =>
    `- [${key}] could move to: ${list.length ? list.map((c) => `${c.id} "${c.title}"${c.dates ? ` (${c.dates})` : ""}`).join("; ") : "no likely topic found"}`).join("\n");
  return `You fix timeline problems on a page of Open Langford, a site that follows Langford City council. An editor
reviewed the page "${heading}" and agreed these problems are real:
${flags.map((f) => `- [${f.key ?? "whole page"}] ${FLAG_PROBLEM_LABELS[f.problem]}: ${f.reason}${f.fix ? `\n  Approved fix (do this): ${f.fix}` : ""}${f.note ? `\n  Editor's instruction for this entry (follow it, over the fix above): ${f.note}` : ""}`).join("\n")}
${note ? `\nTheir note: ${note}\n` : ""}
Two kinds of entries:
- Links found for this topic, which you can remove: ${removable.join(", ") || "none"}. Removing a "background-" entry
  unlinks the whole related topic it came from.
- Items filed under this topic itself ("agenda-" keys), which you can move: to one of the candidate topics listed
  below if it clearly belongs there, or off every topic (to_matter_id null) if none fits.
${movable || "(No flagged items filed under this topic.)"}

An item filed under this topic whose line is vague can get a new line (rewrite_entry, with new_text): one plain
sentence of at most 140 characters saying what this step did for this topic, outcome first ("Council gave second and
third reading to the rezoning for the 165-home Costin Avenue apartments"). Use only facts in its record below; no
file numbers, bylaw numbers or jargon unless the record gives nothing else. Summaries of changed topics are rewritten
automatically. A "Not backed by the record" problem quotes what the record says: fix it with rewrite_entry (a timeline
line, its "agenda-" key) or rewrite_summary (the summary or "where it stands"), saying only what the record supports.
When a related or same-named topic below is the very same project as this page (a duplicate, not
just an earlier or later step), merge_topic with its id folds it into one page.
${lookalikes.length ? `Related and same-named topics:\n${lookalikes.map((c) => `- ${c.id} "${c.title}"${c.dates ? ` (${c.dates})` : ""}`).join("\n")}\n` : ""}A problem with the topic's summary or overall explanation (e.g. "say whether the 2023 agreement
renews the 2021 one") gets rewrite_summary, with a short instruction for the summary writer in new_text; it will
follow it only as far as the records support. For a problem you can't fix with these actions, say cannot_fix and why.
${records.size ? `\nRecords of flagged items:\n${[...records.entries()].map(([key, text]) => `[${key}] ${text}`).join("\n")}` : ""}

For each agreed problem (and anything the note asks), give one action. Don't change anything the editor didn't
agree with or ask for.

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
    const filed = agreed.filter((f) => f.key?.startsWith("agenda-"));
    const candidates = new Map<string, Candidate[]>();
    for (const flag of filed) {
      const { data: item } = await supabase.from("agenda_items").select("title").eq("id", Number(flag.key!.slice(7))).maybeSingle();
      candidates.set(flag.key!, item?.title ? await candidatesFor(supabase, matterId, item.title.split("\n")[0]) : []);
    }
    // The record behind each flagged item filed here: what a rewritten line may say.
    const records = new Map<string, string>();
    for (const flag of filed) {
      const id = Number(flag.key!.slice(7));
      const [{ data: item }, { data: motions }] = await Promise.all([
        supabase.from("agenda_items").select("title, plain_english_summary, meetings(meeting_date)").eq("id", id).maybeSingle(),
        supabase.from("motions").select("text_content, result").eq("agenda_item_id", id).limit(5),
      ]);
      if (!item) continue;
      const meeting = Array.isArray((item as any).meetings) ? (item as any).meetings[0] : (item as any).meetings;
      records.set(flag.key!, [`${meeting?.meeting_date ?? ""}: ${String(item.title || "").split("\n")[0]}`,
        item.plain_english_summary || "",
        ...(motions || []).map((m: any) => `Motion (${m.result || "result not recorded"}): ${String(m.text_content || "").slice(0, 400)}`)]
        .filter(Boolean).join(" | ").slice(0, 1500));
    }
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
    const moves: { item_id: number; to_matter_id: number | null; reason: string }[] = [];
    const merges: { with_matter_id: number; reason: string }[] = [];
    const rewrites: Record<string, string> = {};
    const summaryNotes: string[] = [];
    for (const step of result.data.actions) {
      if (step.action === "merge_topic" && step.to_matter_id && lookalikes.some((c) => c.id === step.to_matter_id)) {
        merges.push({ with_matter_id: step.to_matter_id, reason: step.reason });
        continue;
      }
      if (step.action === "rewrite_summary" && (step.new_text || "").trim()) {
        summaryNotes.push((step.new_text || "").trim().slice(0, 500));
        done.push(`${step.reason} The summary is being rewritten with this note: "${(step.new_text || "").trim()}"`);
        continue;
      }
      if (step.action === "rewrite_entry" && step.key && /^agenda-\d+$/.test(step.key) && onPage.has(step.key)) {
        const text = (step.new_text || "").replace(/\s+/g, " ").trim();
        if (text.length >= 15 && text.length <= 180) {
          rewrites[step.key.slice(7)] = text;
          fixedKeys.add(step.key);
          done.push(`${step.reason} New line: "${text}"`);
        } else left.push(`${step.reason} (the new line wasn't usable, so nothing changed)`);
        continue;
      }
      if (step.action === "move_item" && step.key && /^agenda-\d+$/.test(step.key) && onPage.has(step.key)) {
        const allowed = candidates.get(step.key)?.some((c) => c.id === step.to_matter_id) || step.to_matter_id === null;
        if (allowed) moves.push({ item_id: Number(step.key.slice(7)), to_matter_id: step.to_matter_id, reason: step.reason });
        else left.push(`${step.reason} (the agent picked a topic that wasn't offered, so nothing moved)`);
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
    if (Object.keys(rewrites).length) {
      const { data: matter } = await supabase.from("matters").select("meta").eq("id", matterId).single();
      const meta = (matter?.meta || {}) as Record<string, any>;
      const { error } = await supabase.from("matters").update({ meta: {
        ...meta,
        timeline_headlines: { ...(meta.timeline_headlines || {}), ...rewrites },
        staff_headlines: { ...(meta.staff_headlines || {}), ...rewrites },
      } }).eq("id", matterId);
      if (error) {
        for (const id of Object.keys(rewrites)) fixedKeys.delete(`agenda-${id}`);
        left.push("Couldn't save the rewritten lines.");
      } else {
        await logStaffAction(supabase, { userId: requester.id, role: requester.staffRole, path, action: "agent:rewrite_entry",
          detail: Object.fromEntries(Object.entries(rewrites).map(([id, text]) => [`item ${id}`, text])) });
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
          requested_by: requester.id, role: requester.staffRole },
      });
      if (!error) {
        await supabase.from("page_reviews").update({
          ai_flags: updated, agent_at: new Date().toISOString(),
          agent_note: [done.length ? `Done so far:\n${done.map((d) => `• ${d}`).join("\n")}` : "",
            `Next, on the pipeline worker: ${moves.length ? `move ${moves.length} ${moves.length === 1 ? "item" : "items"}, then ` : ""}${merges.length ? `merge ${merges.length} duplicate ${merges.length === 1 ? "topic" : "topics"}, then ` : ""}rewrite the summary.`]
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
