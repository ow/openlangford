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
 * What it can do today: remove a timeline entry found for the topic, or unlink the related topic an entry came
 * from. What it can't (yet): move an item filed under the wrong topic, or rewrite a summary. It says so.
 */

const PlanSchema = z.object({
  actions: z.array(z.object({
    action: z.enum(["remove_entry", "cannot_fix"]),
    key: z.string().nullable().describe("The entry's key exactly as given, or null."),
    reason: z.string().describe("One plain sentence: what you're doing and why, or why it can't be done here."),
  })),
});

function planPrompt(heading: string, entries: { key: string; text: string }[], flags: PageFlag[], note: string | null) {
  const removable = entries.filter((e) => removableKey(e.key)).map((e) => e.key);
  return `You fix timeline problems on a page of Open Langford, a site that follows Langford City council. An editor
reviewed the page "${heading}" and agreed these problems are real:
${flags.map((f) => `- [${f.key ?? "whole page"}] ${FLAG_PROBLEM_LABELS[f.problem]}: ${f.reason}`).join("\n")}
${note ? `\nTheir note: ${note}\n` : ""}
You can only remove entries with these keys (links found for this topic): ${removable.join(", ") || "none"}.
Removing a "background-" entry unlinks the whole related topic it came from.
Entries with other keys are filed under this topic itself; you can't move them or rewrite text — say "cannot_fix" and why.

For each agreed problem (and anything the note asks), give one action: remove_entry with its key, or cannot_fix.
Don't remove anything the editor didn't agree with or ask for.

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
    const result = await getAiClient().json({
      stage: "review",
      prompt: planPrompt(page.heading || page.title, page.entries, agreed, row?.note ?? null),
      schema: PlanSchema,
      schemaName: "page_fix_plan",
    });

    const onPage = new Set(page.entries.map((e) => e.key));
    const done: string[] = [];
    const left: string[] = [];
    const fixedKeys = new Set<string>();
    for (const step of result.data.actions) {
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
