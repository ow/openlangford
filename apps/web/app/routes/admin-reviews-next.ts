import { redirect } from "react-router";
import type { Route } from "./+types/admin-reviews-next";
import { requireModerator } from "../lib/auth.server";
import { privateAdminHeaders } from "../lib/admin-read.server";
import { getSupabaseAdminClient } from "../lib/supabase.server";
import { randomUnreviewedPath, sectionOf } from "../services/page-reviews.server";
import { SITEMAP_SECTIONS, type SitemapSection } from "../services/sitemap.server";

/** The next page to review: a random page nobody has reviewed or checked, or the list when none are left
 * (or, with ?status=fixed, the next page the agent fixed that's waiting to be confirmed).
 * ?kind=meetings (or any other sitemap section, or "any") starts a run and is remembered in a cookie, so the review
 * bar's ?from=<the page just finished> keeps going in the same mode; without one, the same kind as that page. */
const MODE_COOKIE = "review_mode";

export async function loader({ request }: Route.LoaderArgs) {
  await requireModerator(request);
  const url = new URL(request.url);
  // ?status=fixed: the next page the agent fixed that's waiting to be confirmed (oldest first), else that list.
  if (url.searchParams.get("status") === "fixed") {
    const { data } = await getSupabaseAdminClient().from("page_reviews").select("path").eq("status", "fixed")
      .neq("path", url.searchParams.get("from") || "").order("agent_at", { ascending: true }).limit(1);
    return redirect(data?.[0]?.path || "/admin/reviews?show=fixed", { headers: privateAdminHeaders() });
  }
  const valid = (k: string | null | undefined): k is SitemapSection | "any" =>
    !!k && (k === "any" || (SITEMAP_SECTIONS as readonly string[]).includes(k));
  const asked = url.searchParams.get("kind");
  const remembered = request.headers.get("Cookie")?.match(/(?:^|;\s*)review_mode=([a-z]+)/)?.[1];
  const kind: SitemapSection | "any" = valid(asked) ? asked : valid(remembered) ? remembered
    : sectionOf(url.searchParams.get("from") || "") ?? "any";
  // A skipped page is still unreviewed: don't hand it straight back.
  const from = url.searchParams.get("from");
  let path = await randomUnreviewedPath(getSupabaseAdminClient(), kind);
  for (let tries = 0; path && path === from && tries < 3; tries++) path = await randomUnreviewedPath(getSupabaseAdminClient(), kind);
  if (path === from) path = null;
  const headers = privateAdminHeaders();
  if (valid(asked)) headers.append("Set-Cookie", `${MODE_COOKIE}=${asked}; Path=/; Max-Age=86400; SameSite=Lax; Secure; HttpOnly`);
  return redirect(path || "/admin/reviews", { headers });
}
