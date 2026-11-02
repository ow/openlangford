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
 * once), and move an item filed under the wrong topic to the right one, or off every topic (a fix_page job on the
 * pipeline's quick worker, which also rewrites the summaries of the topics whose timelines changed).
 */

const PlanSchema = z.object({
  actions: z.array(z.object({
    action: z.enum(["remove_entry", "move_item", "cannot_fix"]),
    key: z.string().nullable().describe("The entry's key exactly as given, or null."),
    to_matter_id: z.number().int().nullable().describe("move_item only: a candidate topic's id, or null to take the item off every topic."),
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
  candidates: Map<string, Candidate[]>) {
  const removable = entries.filter((e) => removableKey(e.key)).map((e) => e.key);
  const movable = [...candidates.entries()].map(([key, list]) =>
    `- [${key}] could move to: ${list.length ? list.map((c) => `${c.id} "${c.title}"${c.dates ? ` (${c.dates})` : ""}`).join("; ") : "no likely topic found"}`).join("\n");
  return `You fix timeline problems on a page of Open Langford, a site that follows Langford City council. An editor
reviewed the page "${heading}" and agreed these problems are real:
${flags.map((f) => `- [${f.key ?? "whole page"}] ${FLAG_PROBLEM_LABELS[f.problem]}: ${f.reason}`).join("\n")}
${note ? `\nTheir note: ${note}\n` : ""}
Two kinds of entries:
- Links found for this topic, which you can remove: ${removable.join(", ") || "none"}. Removing a "background-" entry
  unlinks the whole related topic it came from.
- Items filed under this topic itself ("agenda-" keys), which you can move: to one of the candidate topics listed
  below if it clearly belongs there, or off every topic (to_matter_id null) if none fits.
${movable || "(No flagged items filed under this topic.)"}

You can't rewrite an entry's text; the summaries of changed topics are rewritten automatically. For a problem you
can't fix with these actions, say cannot_fix and why.

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
    const result = await getAiClient().json({
      stage: "review",
      prompt: planPrompt(page.heading || page.title, page.entries, agreed, row?.note ?? null, candidates),
      schema: PlanSchema,
      schemaName: "page_fix_plan",
    });

    const onPage = new Set(page.entries.map((e) => e.key));
    const done: string[] = [];
    const left: string[] = [];
    const fixedKeys = new Set<string>();
    const moves: { item_id: number; to_matter_id: number | null; reason: string }[] = [];
    for (const step of result.data.actions) {
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
    // Any agreed flag on an entry that's now gone is resolved, whichever step removed it.
    const updated = flags.map((f) => (f.key && fixedKeys.has(f.key) ? { ...f, fixed: true } : f));
    if (moves.length || done.length) {
      // The pipeline's quick worker moves items and rewrites the changed summaries, then finishes the page.
      const { data: municipality } = await supabase.from("municipalities").select("id").order("id").limit(1).maybeSingle();
      const { error } = await supabase.from("pipeline_jobs").insert({
        municipality_id: municipality?.id ?? 1, job_type: "fix_page", requested_by: requester.id, max_attempts: 1,
        args: { path, moves, refresh: [matterId], done, left, requested_by: requester.id, role: requester.staffRole },
      });
      if (!error) {
        await supabase.from("page_reviews").update({
          ai_flags: updated, agent_at: new Date().toISOString(),
          agent_note: [done.length ? `Done so far:\n${done.map((d) => `• ${d}`).join("\n")}` : "",
            `Next, on the pipeline worker: ${moves.length ? `move ${moves.length} ${moves.length === 1 ? "item" : "items"}, then ` : ""}rewrite the summary.`]
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
