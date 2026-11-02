import { data } from "react-router";
import type { Route } from "./+types/api.page-review";
import { requireModerator } from "../lib/auth.server";
import { adminRead, privateAdminHeaders } from "../lib/admin-read.server";
import { getSupabaseAdminClient } from "../lib/supabase.server";
import { clearPageReview, getPageReview, reviewPath, setPageReview } from "../services/page-reviews.server";
import { checkPage, rateFlag } from "../services/page-check.server";

/** Admin only: whether a public page has been looked over. GET ?path=/matters/x; POST to mark, clear, run a
 * reader's check (intent=check), or rate one of its flags (intent=rate, index, verdict=agree|disagree|none). */
export async function loader({ request }: Route.LoaderArgs) {
  return adminRead(request, async () => {
    const path = reviewPath(new URL(request.url).searchParams.get("path"));
    return { path, review: path ? await getPageReview(getSupabaseAdminClient(), path) : null };
  });
}

export async function action({ request }: Route.ActionArgs) {
  try {
    const user = await requireModerator(request);
    const form = await request.formData();
    const path = reviewPath(String(form.get("path") || ""));
    const intent = String(form.get("intent") || "");
    if (!path || !["reviewed", "needs_work", "clear", "check", "rate"].includes(intent)) {
      return data({ error: "Unknown page or action." }, { status: 400, headers: privateAdminHeaders() });
    }
    const supabase = getSupabaseAdminClient();
    if (intent === "check") await checkPage(supabase, new URL(request.url).origin, path);
    else if (intent === "rate") {
      const index = Number(form.get("index"));
      const verdict = String(form.get("verdict") || "");
      if (!Number.isInteger(index) || index < 0 || !["agree", "disagree", "none"].includes(verdict)) {
        return data({ error: "Unknown rating." }, { status: 400, headers: privateAdminHeaders() });
      }
      await rateFlag(supabase, path, index, verdict === "none" ? null : verdict as "agree" | "disagree");
    } else if (intent === "clear") await clearPageReview(supabase, path);
    else await setPageReview(supabase, {
      path, status: intent as "reviewed" | "needs_work", userId: user.id,
      title: String(form.get("title") || "") || null, note: String(form.get("note") || "") || null,
    });
    return data({ ok: true as const, review: await getPageReview(supabase, path) },
      { headers: privateAdminHeaders() });
  } catch (error) {
    if (error instanceof Response) {
      const headers = new Headers(error.headers);
      privateAdminHeaders().forEach((value, key) => headers.set(key, value));
      throw new Response(error.body, { status: error.status, statusText: error.statusText, headers });
    }
    console.error("[page-review]", error instanceof Error ? error.message : error);
    return data({ error: "Could not save the review. Please try again." }, { status: 503, headers: privateAdminHeaders() });
  }
}
