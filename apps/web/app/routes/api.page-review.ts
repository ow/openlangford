import { data } from "react-router";
import type { Route } from "./+types/api.page-review";
import { requireAdmin } from "../lib/auth.server";
import { adminRead, privateAdminHeaders } from "../lib/admin-read.server";
import { getSupabaseAdminClient } from "../lib/supabase.server";
import { clearPageReview, getPageReview, reviewPath, setPageReview } from "../services/page-reviews.server";

/** Admin only: whether a public page has been looked over. GET ?path=/matters/x; POST to mark or clear. */
export async function loader({ request }: Route.LoaderArgs) {
  return adminRead(request, async () => {
    const path = reviewPath(new URL(request.url).searchParams.get("path"));
    return { path, review: path ? await getPageReview(getSupabaseAdminClient(), path) : null };
  });
}

export async function action({ request }: Route.ActionArgs) {
  try {
    const user = await requireAdmin(request);
    const form = await request.formData();
    const path = reviewPath(String(form.get("path") || ""));
    const intent = String(form.get("intent") || "");
    if (!path || !["reviewed", "needs_work", "clear"].includes(intent)) {
      return data({ error: "Unknown page or action." }, { status: 400, headers: privateAdminHeaders() });
    }
    const supabase = getSupabaseAdminClient();
    if (intent === "clear") await clearPageReview(supabase, path);
    else await setPageReview(supabase, {
      path, status: intent as "reviewed" | "needs_work", userId: user.id,
      title: String(form.get("title") || "") || null, note: String(form.get("note") || "") || null,
    });
    return data({ ok: true as const, review: intent === "clear" ? null : await getPageReview(supabase, path) },
      { headers: privateAdminHeaders() });
  } catch (error) {
    if (error instanceof Response) {
      const headers = new Headers(error.headers);
      privateAdminHeaders().forEach((value, key) => headers.set(key, value));
      throw new Response(error.body, { status: error.status, statusText: error.statusText, headers });
    }
    return data({ error: "Could not save the review. Please try again." }, { status: 503, headers: privateAdminHeaders() });
  }
}
