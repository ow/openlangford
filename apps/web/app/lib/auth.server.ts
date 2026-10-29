import { redirect } from "react-router";
import { createSupabaseServerClient } from "./supabase.server";

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
    const url = new URL(request.url);
    // Include headers in redirect just in case (e.g. clearing invalid session)
    throw redirect(`/login?redirectTo=${encodeURIComponent(url.pathname + url.search)}`, {
      headers,
    });
  }
  
  return user;
}

// 3. Helper to require admin authorization
export async function requireAdmin(request: Request) {
  const user = await requireAuth(request);

  if (!isAdminEmail(user.email)) {
    throw new Response("Admin access is not enabled for this account.", {
      status: 403,
      statusText: "Forbidden",
    });
  }

  return user;
}

// 4. Helper to sign out
export async function signOut(request: Request) {
  const { supabase, headers } = createSupabaseServerClient(request);
  await supabase.auth.signOut();
  return redirect("/login", { headers });
}
