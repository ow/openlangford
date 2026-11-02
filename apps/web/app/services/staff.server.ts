import type { SupabaseClient } from "@supabase/supabase-js";
import type { StaffRole } from "../lib/auth.server";

export type StaffAction = { id: number; role: string; path: string; action: string | null; detail: Record<string, string>; created_at: string };

// Never stored: anything that looks like a secret.
const SECRET = /pass|token|secret|key|otp|code/i;

/** The form or JSON fields of a staff request, small and without secrets: what was changed, not the files. */
export async function requestDetail(request: Request): Promise<Record<string, string>> {
  const type = request.headers.get("content-type") || "";
  const out: Record<string, string> = {};
  const keep = (key: string, value: unknown) => {
    if (SECRET.test(key) || value == null || typeof value === "object") return;
    if (Object.keys(out).length < 20) out[key] = String(value).slice(0, 500);
  };
  try {
    if (type.includes("application/json")) {
      const body = await request.clone().json();
      if (body && typeof body === "object") Object.entries(body).forEach(([k, v]) => keep(k, v));
    } else if (type.includes("form")) {
      (await request.clone().formData()).forEach((v, k) => typeof v === "string" && keep(k, v));
    }
  } catch {
    // An unreadable body still gets its row, without detail.
  }
  return out;
}

export async function logStaffAction(supabase: SupabaseClient, entry: {
  userId: string; role: StaffRole; path: string; action?: string | null; detail?: Record<string, string>;
}) {
  const { error } = await supabase.from("staff_actions").insert({
    user_id: entry.userId, role: entry.role, path: entry.path.slice(0, 500),
    action: entry.action?.slice(0, 100) || null, detail: entry.detail || {},
  });
  if (error) console.error("[staff] could not record action:", error.message);
}

export async function getUserStaff(supabase: SupabaseClient, userId: string) {
  const none = { grantedRole: null, grantedAt: null, actions: [] as StaffAction[] };
  try {
    return await readUserStaff(supabase, userId);
  } catch {
    return none;  // the account page still loads without its staff section's data
  }
}

async function readUserStaff(supabase: SupabaseClient, userId: string) {
  const [role, actions] = await Promise.all([
    supabase.from("user_roles").select("role, granted_at").eq("user_id", userId).maybeSingle(),
    supabase.from("staff_actions").select("id, role, path, action, detail, created_at").eq("user_id", userId)
      .order("created_at", { ascending: false }).limit(50),
  ]);
  return {
    grantedRole: (role.data?.role as StaffRole | undefined) ?? null,
    grantedAt: role.data?.granted_at ?? null,
    actions: (actions.data || []) as StaffAction[],
  };
}

export async function setUserRole(supabase: SupabaseClient, userId: string, role: StaffRole | null, grantedBy: string) {
  const { error } = role
    ? await supabase.from("user_roles").upsert({ user_id: userId, role, granted_by: grantedBy, granted_at: new Date().toISOString() })
    : await supabase.from("user_roles").delete().eq("user_id", userId);
  if (error) throw new Error("Could not change the role.");
}
