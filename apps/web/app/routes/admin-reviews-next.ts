import { redirect } from "react-router";
import type { Route } from "./+types/admin-reviews-next";
import { requireModerator } from "../lib/auth.server";
import { privateAdminHeaders } from "../lib/admin-read.server";
import { getSupabaseAdminClient } from "../lib/supabase.server";
import { randomUncheckedMatterPath } from "../services/page-check.server";

/** The next page to review: a random topic page nobody has reviewed or checked, or the list when none are left.
 * The review bar goes here after Reviewed or Needs work, so staff never wait on a page they've finished. */
export async function loader({ request }: Route.LoaderArgs) {
  await requireModerator(request);
  const path = await randomUncheckedMatterPath(getSupabaseAdminClient());
  return redirect(path || "/admin/reviews", { headers: privateAdminHeaders() });
}
