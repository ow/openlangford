import { redirect } from "react-router";
import type { Route } from "./+types/admin-reviews-next";
import { requireModerator } from "../lib/auth.server";
import { privateAdminHeaders } from "../lib/admin-read.server";
import { getSupabaseAdminClient } from "../lib/supabase.server";
import { randomUnreviewedPath, sectionOf } from "../services/page-reviews.server";
import { SITEMAP_SECTIONS, type SitemapSection } from "../services/sitemap.server";

/** The next page to review: a random page nobody has reviewed or checked, or the list when none are left.
 * ?kind=meetings (or any other sitemap section, or "any") starts a run and is remembered in a cookie, so the review
 * bar's ?from=<the page just finished> keeps going in the same mode; without one, the same kind as that page. */
const MODE_COOKIE = "review_mode";

export async function loader({ request }: Route.LoaderArgs) {
  await requireModerator(request);
  const url = new URL(request.url);
  const valid = (k: string | null | undefined): k is SitemapSection | "any" =>
    !!k && (k === "any" || (SITEMAP_SECTIONS as readonly string[]).includes(k));
  const asked = url.searchParams.get("kind");
  const remembered = request.headers.get("Cookie")?.match(/(?:^|;\s*)review_mode=([a-z]+)/)?.[1];
  const kind: SitemapSection | "any" = valid(asked) ? asked : valid(remembered) ? remembered
    : sectionOf(url.searchParams.get("from") || "") ?? "any";
  const path = await randomUnreviewedPath(getSupabaseAdminClient(), kind);
  const headers = privateAdminHeaders();
  if (valid(asked)) headers.append("Set-Cookie", `${MODE_COOKIE}=${asked}; Path=/; Max-Age=86400; SameSite=Lax; Secure; HttpOnly`);
  return redirect(path || "/admin/reviews", { headers });
}
