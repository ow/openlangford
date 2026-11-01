import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import type { ApiEnv } from "./types";
import { ApiError } from "./lib/api-errors";
import { apiKeyAuth } from "./middleware/auth";
import { rateLimit } from "./middleware/rate-limit";
import { isAdminUser } from "~/lib/auth.server";
import { getSupabaseAdminClient } from "~/lib/supabase.server";
import { checkPage, randomUncheckedMatterPath, rateFlag } from "~/services/page-check.server";
import { getPageReview, listPageReviews, reviewPath } from "~/services/page-reviews.server";

/**
 * Page checks for agents (and scripts), with an admin's API key from /settings/api-keys. Not in the public
 * API docs. The same checks and ratings the admin review bar uses:
 *
 *   GET  /api/v1/admin/page-checks?path=/matters/x   one page's stored check and review
 *   GET  /api/v1/admin/page-checks?show=flagged      recent checks (show: flagged | needs_work | reviewed)
 *   GET  /api/v1/admin/page-checks/random            a matter page nobody has reviewed or checked
 *   POST /api/v1/admin/page-checks        {path}     run a reader's check now
 *   POST /api/v1/admin/page-checks/rate   {path, index, verdict: agree|disagree|none}
 */
const adminOnly = createMiddleware<ApiEnv>(async (c, next) => {
  const userId = c.get("userId");
  const { data } = userId ? await getSupabaseAdminClient().auth.admin.getUserById(userId) : { data: null };
  if (!isAdminUser(data?.user)) throw new ApiError(403, "FORBIDDEN", "This API key's account is not an admin.");
  await next();
});

const noStore = { "Cache-Control": "private, no-store" };
const pathOf = (value: unknown) => {
  const path = reviewPath(typeof value === "string" ? value : null);
  if (!path) throw new ApiError(400, "INVALID_PATH", "Pass a site path such as /matters/some-topic.");
  return path;
};

const app = new Hono<ApiEnv>();
app.use("*", apiKeyAuth, rateLimit, adminOnly);

app.get("/", async (c) => {
  const supabase = getSupabaseAdminClient();
  if (c.req.query("path")) return c.json({ review: await getPageReview(supabase, pathOf(c.req.query("path"))) }, 200, noStore);
  const show = c.req.query("show");
  const filter = show === "flagged" || show === "needs_work" || show === "reviewed" ? show : null;
  const { reviews, agreement } = await listPageReviews(supabase, filter);
  return c.json({ reviews, agreement }, 200, noStore);
});

app.get("/random", async (c) => c.json({ path: await randomUncheckedMatterPath(getSupabaseAdminClient()) }, 200, noStore));

app.post("/", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const check = await checkPage(getSupabaseAdminClient(), new URL(c.req.url).origin, pathOf(body.path));
  return c.json(check, 200, noStore);
});

app.post("/rate", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const index = Number(body.index);
  if (!Number.isInteger(index) || index < 0 || !["agree", "disagree", "none"].includes(body.verdict)) {
    throw new ApiError(400, "INVALID_RATING", "Pass index (the flag's position) and verdict: agree, disagree or none.");
  }
  const flags = await rateFlag(getSupabaseAdminClient(), pathOf(body.path), index, body.verdict === "none" ? null : body.verdict);
  return c.json({ flags }, 200, noStore);
});

export default app;
