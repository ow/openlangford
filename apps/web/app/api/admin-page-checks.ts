import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import type { ApiEnv } from "./types";
import { ApiError } from "./lib/api-errors";
import { apiKeyAuth } from "./middleware/auth";
import { rateLimit } from "./middleware/rate-limit";
import { getStaffRole } from "~/lib/auth.server";
import { getSupabaseAdminClient } from "~/lib/supabase.server";
import { checkPage, randomUncheckedMatterPath, rateAllFlags, rateFlag } from "~/services/page-check.server";
import { fixPage } from "~/services/page-fix.server";
import { unresolvedFlags } from "~/lib/page-review-types";
import { clearPageReview, getPageReview, listPageReviews, reviewPath, setPageReview } from "~/services/page-reviews.server";
import { logStaffAction, requestDetail } from "~/services/staff.server";
import { PRIVATE } from "../lib/cache-policy";

/**
 * Page checks for agents (and scripts), with a moderator's or admin's API key from /settings/api-keys. Not in the public
 * API docs. The same checks and ratings the admin review bar uses:
 *
 *   GET  /api/v1/admin/page-checks?path=/matters/x   one page's stored check and review
 *   GET  /api/v1/admin/page-checks?show=flagged      recent checks (show: flagged | needs_work | reviewed)
 *   GET  /api/v1/admin/page-checks/random            a matter page nobody has reviewed or checked
 *   POST /api/v1/admin/page-checks        {path}     run a reader's check now
 *   POST /api/v1/admin/page-checks/rate   {path, index, verdict: agree|disagree|none}
 *   POST /api/v1/admin/page-checks/rate   {path, all: true, verdict: agree|disagree}   every undecided flag
 *   POST /api/v1/admin/page-checks/fix    {path, note?}  send the agreed flags (and note) to the fix agent; waits for it
 *   POST /api/v1/admin/page-checks/review {path, status: reviewed|clear}  reviewed only when no flag is left open
 */
const adminOnly = createMiddleware<ApiEnv>(async (c, next) => {
  const userId = c.get("userId");
  const { data } = userId ? await getSupabaseAdminClient().auth.admin.getUserById(userId) : { data: null };
  const role = await getStaffRole(data?.user);
  if (!role) throw new ApiError(403, "FORBIDDEN", "This API key's account has no staff role.");
  c.set("staffRole", role);
  if (c.req.method === "POST") {
    const detail = await requestDetail(c.req.raw);
    const action = c.req.path.match(/\/(rate|fix|review)$/)?.[1] ?? "check";
    await logStaffAction(getSupabaseAdminClient(), { userId: userId!, role, path: c.req.path, action: `api:${action}`, detail });
  }
  await next();
});

const noStore = { "Cache-Control": PRIVATE };
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
  if (body.all === true) {
    if (!["agree", "disagree"].includes(body.verdict)) throw new ApiError(400, "INVALID_RATING", "Pass verdict: agree or disagree.");
    return c.json({ flags: await rateAllFlags(getSupabaseAdminClient(), pathOf(body.path), body.verdict, c.get("userId")) }, 200, noStore);
  }
  const index = Number(body.index);
  if (!Number.isInteger(index) || index < 0 || !["agree", "disagree", "none"].includes(body.verdict)) {
    throw new ApiError(400, "INVALID_RATING", "Pass index (the flag's position) and verdict: agree, disagree or none.");
  }
  const flags = await rateFlag(getSupabaseAdminClient(), pathOf(body.path), index, body.verdict === "none" ? null : body.verdict, c.get("userId"));
  return c.json({ flags }, 200, noStore);
});

app.post("/fix", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const path = pathOf(body.path);
  const supabase = getSupabaseAdminClient();
  const userId = c.get("userId")!;
  const note = typeof body.note === "string" && body.note.trim() ? body.note.trim().slice(0, 2000) : null;
  await setPageReview(supabase, { path, status: "fixing", userId, title: null, note });
  // As the review bar does: the request waits for the agent, and waitUntil covers it if the caller drops.
  const run = fixPage(supabase, new URL(c.req.url).origin, path, { id: userId, staffRole: c.get("staffRole")! });
  try { c.executionCtx.waitUntil(run); } catch { /* no execution context outside the Worker */ }
  const outcome = (await run) || "done";
  return c.json({ outcome, review: await getPageReview(supabase, path) }, 200, noStore);
});

app.post("/review", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const path = pathOf(body.path);
  const supabase = getSupabaseAdminClient();
  if (body.status === "clear") {
    await clearPageReview(supabase, path);
  } else if (body.status === "reviewed") {
    const open = unresolvedFlags((await getPageReview(supabase, path))?.ai_flags);
    if (open.length) throw new ApiError(409, "FLAGS_OPEN", `${open.length} ${open.length === 1 ? "flag is" : "flags are"} still open. Rate each one, and fix the ones you agree with.`);
    await setPageReview(supabase, { path, status: "reviewed", userId: c.get("userId")!, title: null, note: null });
  } else {
    throw new ApiError(400, "INVALID_STATUS", "Pass status: reviewed or clear.");
  }
  return c.json({ review: await getPageReview(supabase, path) }, 200, noStore);
});

export default app;
