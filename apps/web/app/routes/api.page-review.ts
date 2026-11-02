import { data } from "react-router";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Route } from "./+types/api.page-review";
import { requireModerator } from "../lib/auth.server";
import { adminRead, privateAdminHeaders } from "../lib/admin-read.server";
import { getSupabaseAdminClient } from "../lib/supabase.server";
import { clearPageReview, getPageReview, reviewPath, setPageReview } from "../services/page-reviews.server";
import { checkPage, rateFlag, resolveFlags } from "../services/page-check.server";
import { fixPage } from "../services/page-fix.server";
import { unresolvedFlags } from "../lib/page-review-types";
import {
  decideSuggestion, latestFindJob, listSuggestions, matterForPath, removableKey, removeEntry, requestFindMissing,
} from "../services/page-links.server";

const INTENTS = ["reviewed", "needs_work", "clear", "check", "rate", "handled", "remove_entry", "find_missing", "accept", "reject"];

/** On a topic page: suggestions waiting for a decision, and the latest "find missing" search. */
async function linkState(supabase: SupabaseClient, path: string) {
  const matterId = await matterForPath(supabase, path);
  if (!matterId) return null;
  const [suggestions, findJob] = await Promise.all([listSuggestions(supabase, matterId), latestFindJob(supabase, matterId)]);
  return { suggestions, findJob };
}

/** Staff only: a public page's review. GET ?path=/matters/x. POST to mark or clear it; run a reader's check
 * (intent=check) or rate one of its flags (rate: index, verdict=agree|disagree|none); and on a topic page, remove a
 * timeline entry (remove_entry: key), search for missing links (find_missing), or decide a suggestion
 * (accept|reject: table, id). Every POST is recorded in staff_actions by requireModerator. */
export async function loader({ request }: Route.LoaderArgs) {
  return adminRead(request, async () => {
    const path = reviewPath(new URL(request.url).searchParams.get("path"));
    const supabase = getSupabaseAdminClient();
    return {
      path,
      review: path ? await getPageReview(supabase, path) : null,
      links: path ? await linkState(supabase, path) : null,
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

    if (intent === "check") await checkPage(supabase, new URL(request.url).origin, path);
    else if (intent === "rate") {
      const index = Number(form.get("index"));
      const verdict = String(form.get("verdict") || "");
      if (!Number.isInteger(index) || index < 0 || !["agree", "disagree", "none"].includes(verdict)) return bad("Unknown rating.");
      await rateFlag(supabase, path, index, verdict === "none" ? null : verdict as "agree" | "disagree");
    } else if (intent === "remove_entry" || intent === "find_missing" || intent === "accept" || intent === "reject") {
      const matterId = await matterForPath(supabase, path);
      if (!matterId) return bad("This only works on a topic page.");
      if (intent === "remove_entry") {
        const key = String(form.get("key") || "");
        if (!removableKey(key)) return bad("That entry can't be removed here.");
        message = await removeEntry(supabase, matterId, key, user.id);
        // Removing a flagged entry agrees with its flag (which teaches later checks) and resolves it.
        await resolveFlags(supabase, path, { key });
      } else if (intent === "find_missing") {
        await requestFindMissing(supabase, matterId, user.id);
        message = "Searching. Suggestions appear here when the pipeline has run.";
      } else {
        const table = String(form.get("table") || "");
        const id = Number(form.get("id"));
        if ((table !== "matter_links" && table !== "matter_report_mentions") || !Number.isSafeInteger(id)) return bad("Unknown suggestion.");
        await decideSuggestion(supabase, matterId, table, id, intent === "accept", user.id);
      }
    } else if (intent === "handled") {
      // An agreed flag fixed some other way (or that can't be fixed here and is being let go).
      const index = Number(form.get("index"));
      if (!Number.isInteger(index) || index < 0) return bad("Unknown flag.");
      await resolveFlags(supabase, path, { index });
    } else if (intent === "clear") await clearPageReview(supabase, path);
    else if (intent === "reviewed") {
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
      const run = fixPage(supabase, new URL(request.url).origin, path, user);
      const ctx = (context as { cloudflare?: { ctx?: ExecutionContext } } | undefined)?.cloudflare?.ctx;
      if (ctx?.waitUntil) ctx.waitUntil(run);
      else void run;
      message = "The agent is working on this page now.";
    }
    return data({ ok: true as const, message, review: await getPageReview(supabase, path), links: await linkState(supabase, path) },
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
