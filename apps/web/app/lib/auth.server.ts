import { redirect } from "react-router";
import { createSupabaseServerClient, getSupabaseAdminClient } from "./supabase.server";

/** The admin allowlist used by requireAdmin; also the recipients of contact-form notifications. */
export function getConfiguredAdminEmails() {
  return (process.env.ADMIN_EMAILS || process.env.ADMIN_EMAIL || "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
}

export function isAdminEmail(email?: string | null) {
  const adminEmails = getConfiguredAdminEmails();

  if (adminEmails.length === 0) {
    // New accounts must never inherit admin access, including in previews/dev.
    return false;
  }

  return email ? adminEmails.includes(email.toLowerCase()) : false;
}

/** Admin = allowlisted email that the user has confirmed (Supabase sets email_confirmed_at). */
export function isAdminUser(user?: { email?: string | null; email_confirmed_at?: string | null } | null) {
  return !!user?.email_confirmed_at && isAdminEmail(user.email);
}

/**
 * Staff roles. Admins (the ADMIN_EMAILS owners, or a granted "admin") use every tool; moderators use all but
 * pipeline operations, people and memberships, and granting roles. Granted in /admin/users (user_roles).
 */
export type StaffRole = "admin" | "moderator";
const RANK: Record<StaffRole, number> = { moderator: 1, admin: 2 };

export function hasRole(role: StaffRole | null | undefined, minimum: StaffRole) {
  return !!role && RANK[role] >= RANK[minimum];
}

type RoleUser = { id?: string; email?: string | null; email_confirmed_at?: string | null };

export async function getStaffRole(user?: RoleUser | null): Promise<StaffRole | null> {
  if (!user?.email_confirmed_at) return null;
  if (isAdminEmail(user.email)) return "admin";
  if (!user.id) return null;
  const { data, error } = await getSupabaseAdminClient().from("user_roles").select("role").eq("user_id", user.id).maybeSingle();
  if (error) return null;
  return data?.role === "admin" || data?.role === "moderator" ? data.role : null;
}

// 1. Helper to check if user is authenticated
export async function isAuthenticated(request: Request) {
  const { supabase } = createSupabaseServerClient(request);
  const { data: { user } } = await supabase.auth.getUser();
  return !!user;
}

// 2. Helper to require authentication (redirects if not)
export async function requireAuth(request: Request) {
  const { supabase, headers } = createSupabaseServerClient(request);
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    // Include headers in redirect just in case (e.g. clearing invalid session)
    throw redirect(`/login?redirectTo=${encodeURIComponent(loginReturnPath(request))}`, { headers });
  }
  
  return user;
}

/** Where to come back to after signing in. An API request (the review bar's polling, say) returns to the page it
 * was about, never to the API URL itself: signing in would then show a JSON response. */
export function loginReturnPath(request: Request) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/")) return url.pathname + url.search;
  const page = url.searchParams.get("path");
  if (page && /^\/(?!\/)[^\s]*$/.test(page)) return page;
  const referer = request.headers.get("referer");
  if (referer) {
    try {
      const from = new URL(referer);
      if (from.origin === url.origin && !from.pathname.startsWith("/api/")) return from.pathname + from.search;
    } catch { /* not a URL */ }
  }
  return "/";
}

// 3. Helpers to require a staff role: requireModerator for most tools, requireAdmin for the rest
export async function requireRole(request: Request, minimum: StaffRole, { record = true }: { record?: boolean } = {}) {
  const user = await requireAuth(request);
  const role = await getStaffRole(user);

  if (!hasRole(role, minimum)) {
    throw new Response(minimum === "admin" ? "This needs an admin account." : "Admin access is not enabled for this account.", {
      status: 403,
      statusText: "Forbidden",
    });
  }

  // Who did what: every change made through a staff tool is recorded (reads are not).
  // A failed record never blocks the change itself.
  if (record && request.method !== "GET" && request.method !== "HEAD") {
    try {
      const { logStaffAction, requestDetail } = await import("../services/staff.server");
      const detail = await requestDetail(request);
      await logStaffAction(getSupabaseAdminClient(), {
        userId: user.id, role: role as StaffRole, path: new URL(request.url).pathname,
        action: detail.intent || detail._action || null, detail,
      });
    } catch (error) {
      console.error("[staff] could not record action:", error instanceof Error ? error.message : error);
    }
  }

  return Object.assign(user, { staffRole: role as StaffRole });
}

export const requireAdmin = (request: Request) => requireRole(request, "admin");
export const requireModerator = (request: Request) => requireRole(request, "moderator");

// 4. Helper to sign out
export async function signOut(request: Request) {
  const { supabase, headers } = createSupabaseServerClient(request);
  await supabase.auth.signOut();
  return redirect("/login", { headers });
}
