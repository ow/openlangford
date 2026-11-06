import { data } from "react-router";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Route } from "./+types/api.page-review";
import { requireModerator } from "../lib/auth.server";
import { adminRead, privateAdminHeaders } from "../lib/admin-read.server";
import { getSupabaseAdminClient } from "../lib/supabase.server";
import { clearPageReview, getPageReview, reviewPath, setInternalNote, setPageReview } from "../services/page-reviews.server";
import { addEditorIssue, checkPage, rateFlag, resolveFlags, setFlagNote } from "../services/page-check.server";
import { fixPage } from "../services/page-fix.server";
import { unresolvedFlags } from "../lib/page-review-types";
import {
  agreeSuggestion, decideSuggestion, latestFindJob, listSuggestions, matterForPath, removableKey, removeEntry, requestFindMissing,
} from "../services/page-links.server";
import { isPageHidden, setPageHidden } from "../services/page-visibility.server";
import { confirmTopicEdits, imageCandidates, resetTopicField, saveTopicEdit, topicEditState, type TopicEdit } from "../services/topic-edit.server";
import { EDIT_FIELDS, type EditField } from "../lib/topic-edit";

const INTENTS = ["reviewed", "needs_work", "clear", "check", "rate", "flag_note", "add_issue", "handled", "remove_entry", "find_missing", "accept", "reject", "hide_page", "unhide_page", "internal_note",
  "edit_topic", "reset_field", "keep_edits"];

/** On a topic page: suggestions waiting for a decision, and the latest "find missing" search. */
async function linkState(supabase: SupabaseClient, path: string) {
  const matterId = await matterForPath(supabase, path);
  if (!matterId) return null;
  const [suggestions, findJob, edit] = await Promise.all([
    listSuggestions(supabase, matterId), latestFindJob(supabase, matterId), topicEditState(supabase, matterId),
  ]);
  // No feature photo, but report pictures to choose one from: the bar points at the edit dialog.
  const photos = edit.image ? 0 : (await imageCandidates(supabase, matterId)).length;
  return { suggestions, findJob, edited: { locked: edit.locked, newEntries: edit.newEntries, photos } };
}

/** What every page's bar needs, and on a topic page its links and edits. */
async function pageState(supabase: SupabaseClient, path: string) {
  const [links, hidden] = await Promise.all([linkState(supabase, path), isPageHidden(supabase, path)]);
  return { links, hidden };
}

/** Staff only: a public page's review. GET ?path=/matters/x. POST to mark or clear it; run a reader's check
 * (intent=check) or rate one of its flags (rate: index, verdict=agree|disagree|none); and on a topic page, remove a
 * timeline entry (remove_entry: key), search for missing links (find_missing), or decide a suggestion
 * (accept|reject: table, id). Every POST is recorded in staff_actions by requireModerator. */
export async function loader({ request }: Route.LoaderArgs) {
  return adminRead(request, async () => {
    const path = reviewPath(new URL(request.url).searchParams.get("path"));
    const supabase = getSupabaseAdminClient();
    const params = new URL(request.url).searchParams;
    // The edit panel asks for the topic's current text and the pictures it can choose from.
    if (path && params.get("edit") === "1") {
      const matterId = await matterForPath(supabase, path);
      return { path, edit: matterId ? await topicEditState(supabase, matterId, { withImages: true }) : null };
    }
    return {
      path,
      review: path ? await getPageReview(supabase, path) : null,
      ...(path ? await pageState(supabase, path) : { links: null, hidden: false }),
    };
  });
}

export async function action({ request, context }: Route.ActionArgs) {
  try {
    const user = await requireModerator(request);
    const form = await request.formData();
    const path = reviewPath(String(form.get("path") || ""));
    const intent = String(form.get("intent") || "");
    const bad = (error: string) => data({ error }, { status: 400, headers: privateAdminHeaders() });
    if (!path || !INTENTS.includes(intent)) return bad("Unknown page or action.");
    const supabase = getSupabaseAdminClient();
    let message: string | null = null;

    if (intent === "check") {
      // On a topic page, the same press also searches for entries missing from it (the pipeline's quick worker),
      // started first so it runs while the page is being checked rather than after.
      const matterId = await matterForPath(supabase, path);
      const running = matterId ? await latestFindJob(supabase, matterId) : null;
      if (matterId && !(running && (running.status === "queued" || running.status === "running"))) {
        await requestFindMissing(supabase, matterId, user.id);
      }
      await checkPage(supabase, new URL(request.url).origin, path);
    }
    else if (intent === "rate") {
      const index = Number(form.get("index"));
      const verdict = String(form.get("verdict") || "");
      if (!Number.isInteger(index) || index < 0 || !["agree", "disagree", "none"].includes(verdict)) return bad("Unknown rating.");
      await rateFlag(supabase, path, index, verdict === "none" ? null : verdict as "agree" | "disagree", user.id);
    } else if (intent === "hide_page" || intent === "unhide_page") {
      const note = String(form.get("note") || "").trim();
      if (intent === "hide_page" && !note) return bad("Say why you're hiding this page.");
      await setPageHidden(supabase, path, intent === "hide_page", { note, userId: user.id, title: String(form.get("title") || "") || null });
      message = intent === "hide_page" ? "This page is now hidden from the public: anyone else gets “not found”." : "This page is public again.";
    } else if (["remove_entry", "find_missing", "accept", "reject", "edit_topic", "reset_field", "keep_edits"].includes(intent)) {
      const matterId = await matterForPath(supabase, path);
      if (!matterId) return bad("This only works on a topic page.");
      if (intent === "edit_topic") {
        const edit: TopicEdit = {};
        // "topic_title", not "title": every request also sends the browser tab's title as "title" (the review's label).
        for (const [field, key] of [["topic_title", "title"], ["summary", "summary"], ["status_line", "status_line"]] as const) {
          if (form.has(field)) edit[key] = String(form.get(field));
        }
        if (form.has("image")) {
          const image = String(form.get("image"));
          edit.image = { id: image === "none" ? "none" : Number(image), kind: String(form.get("image_kind") || "") || null };
          if (edit.image.id !== "none" && !Number.isSafeInteger(edit.image.id)) return bad("Unknown picture.");
        }
        const { changed } = await saveTopicEdit(supabase, matterId, edit, user.id);
        message = changed ? "Saved. The pipeline will leave the fields you edited alone." : "Nothing changed.";
      } else if (intent === "reset_field") {
        const field = String(form.get("field") || "") as EditField;
        if (!EDIT_FIELDS.includes(field)) return bad("Unknown field.");
        await resetTopicField(supabase, matterId, field);
        message = "Back to the automatic version.";
      } else if (intent === "keep_edits") {
        await confirmTopicEdits(supabase, matterId);
        message = "Kept your edits.";
      } else if (intent === "remove_entry") {
        const key = String(form.get("key") || "");
        if (!removableKey(key)) return bad("That entry can't be removed here.");
        message = await removeEntry(supabase, matterId, key, user.id);
        // Removing a flagged entry agrees with its flag (which teaches later checks) and resolves it.
        await resolveFlags(supabase, path, { key }, user.id);
      } else if (intent === "find_missing") {
        await requestFindMissing(supabase, matterId, user.id);
        message = "Searching. Suggestions appear here when the pipeline has run.";
      } else {
        const table = String(form.get("table") || "");
        const id = Number(form.get("id"));
        if ((table !== "matter_links" && table !== "matter_report_mentions") || !Number.isSafeInteger(id)) return bad("Unknown suggestion.");
        // 👍 marks it agreed (added by the agent on the next Fix); 👎 rejects it now (that changes nothing on the page).
        if (intent === "accept") await agreeSuggestion(supabase, matterId, table, id, form.get("agree") !== "0", user.id);
        else await decideSuggestion(supabase, matterId, table, id, false, user.id);
      }
    } else if (intent === "add_issue") {
      await addEditorIssue(supabase, path, String(form.get("note") || ""),
        String(form.get("title") || "").replace(/\s*\|\s*Open Langford\s*$/, "") || null);
    } else if (intent === "flag_note") {
      const index = Number(form.get("index"));
      if (!Number.isInteger(index) || index < 0) return bad("Unknown flag.");
      await setFlagNote(supabase, path, index, String(form.get("note") || ""), user.id);
    } else if (intent === "handled") {
      // An agreed flag fixed some other way (or that can't be fixed here and is being let go).
      const index = Number(form.get("index"));
      if (!Number.isInteger(index) || index < 0) return bad("Unknown flag.");
      await resolveFlags(supabase, path, { index }, user.id);
    } else if (intent === "internal_note") {
      await setInternalNote(supabase, path, String(form.get("note") || ""), user.id, String(form.get("title") || "") || null);
    } else if (intent === "clear") await clearPageReview(supabase, path);
    else if (intent === "reviewed") {
      const current = await getPageReview(supabase, path);
      // Confirming the agent's fix with flags it couldn't finish (waiting on records, say): staff set them aside.
      if (form.get("set_aside") === "1" && current?.status === "fixed") {
        const flags = current.ai_flags || [];
        for (const [index, flag] of flags.entries()) {
          if (unresolvedFlags([flag]).length) await resolveFlags(supabase, path, { index }, user.id);
        }
      }
      const open = unresolvedFlags((await getPageReview(supabase, path))?.ai_flags);
      if (open.length) {
        return bad(`${open.length} ${open.length === 1 ? "flag is" : "flags are"} still open. Rate each one, and fix or mark handled the ones you agree with.`);
      }
      await setPageReview(supabase, { path, status: "reviewed", userId: user.id, title: String(form.get("title") || "") || null, note: null });
    } else {
      // Needs work: the fix agent starts on the server now; the bar shows "Fixing…" until it's done.
      await setPageReview(supabase, {
        path, status: "fixing", userId: user.id,
        title: String(form.get("title") || "") || null, note: String(form.get("note") || "") || null,
      });
      // The request waits for the agent: work left to waitUntil is cut off about 30 seconds after the response, which a
      // fix that researches the record outlasts (2026-11-03: a page stayed "fixing" after its research calls). waitUntil
      // still covers the run if the browser drops the request.
      const run = fixPage(supabase, new URL(request.url).origin, path, user);
      const ctx = (context as { cloudflare?: { ctx?: ExecutionContext } } | undefined)?.cloudflare?.ctx;
      ctx?.waitUntil?.(run);
      const outcome = await run;
      message = outcome === "nothing_new"
        ? "Nothing new for the agent: every flag rated 👍 is already fixed. Rate an open flag 👍, or say what's still wrong, to send it more."
        : outcome === "refiling"
          ? "The agent has done the rest; re-filing an item is still running on the pipeline worker."
          : "The agent has finished with this page.";
    }
    return data({ ok: true as const, message, review: await getPageReview(supabase, path), ...(await pageState(supabase, path)) },
      { headers: privateAdminHeaders() });
  } catch (error) {
    if (error instanceof Response) {
      const headers = new Headers(error.headers);
      privateAdminHeaders().forEach((value, key) => headers.set(key, value));
      throw new Response(error.body, { status: error.status, statusText: error.statusText, headers });
    }
    console.error("[page-review]", error instanceof Error ? error.message : error);
    const message = error instanceof Error && /^(Could not|That entry)/.test(error.message) ? error.message : "Could not save the review. Please try again.";
    return data({ error: message }, { status: 503, headers: privateAdminHeaders() });
  }
}
