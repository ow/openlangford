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

const ROLE_EMAIL_FROM = "Open Langford <alerts@openlangford.ca>";
const ADMIN_URL = "https://openlangford.ca/admin";

/** The welcome email for someone just made a moderator or admin. */
export function buildRoleGrantEmail(role: StaffRole, to: string) {
  const title = role === "admin" ? "admin" : "moderator";
  const can = role === "admin"
    ? "This means you can review content, contribute to the site, run its tools, manage staff and more."
    : "This means you can review content, contribute to the site, and more.";
  const subject = `You're now a ${title} on Open Langford`;
  const text = [
    `You have been granted ${title} powers on OpenLangford.ca. ${can}`,
    "",
    "With great power comes great responsibility, so please use it wisely. All activity is logged.",
    "",
    `You may now enter the restricted admin area: ${ADMIN_URL}`,
  ].join("\n");
  const html = `<p>You have been granted ${title} powers on OpenLangford.ca. ${can}</p>
<p>With great power comes great responsibility, so please use it wisely. <em>All activity is logged.</em></p>
<p>You may now enter the restricted admin area: <a href="${ADMIN_URL}">${ADMIN_URL}</a></p>`;
  return { from: ROLE_EMAIL_FROM, to: [to], reply_to: "admin@openlangford.ca", subject, text, html };
}

/** Emails a newly granted moderator or admin. Never throws: the role change stands either way. */
export async function sendRoleGrantEmail({ apiKey, to, role, userId, supabase, fetcher = fetch }: {
  apiKey: string | undefined; to: string | null | undefined; role: StaffRole; userId: string;
  /** Records the email in the ledger (email_messages) so it shows in /admin/emails. */
  supabase?: SupabaseClient; fetcher?: typeof fetch;
}): Promise<"sent" | "skipped" | "failed"> {
  if (!apiKey || !to) return "skipped";
  // One welcome per person, role and day, however often the form is sent.
  const key = `role-grant-${userId}-${role}-${new Date().toISOString().slice(0, 10)}`;
  const email = buildRoleGrantEmail(role, to);
  let providerId: string | null = null;
  let error: string | null = null;
  try {
    const response = await fetcher("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", "Idempotency-Key": key },
      body: JSON.stringify(email),
      signal: AbortSignal.timeout(15000),
    });
    if (response.ok) providerId = ((await response.json().catch(() => null)) as { id?: string } | null)?.id ?? null;
    else error = `Resend answered ${response.status}`;
  } catch {
    error = "Network error";
  }
  if (error) console.error(`[staff] Role email failed (${error})`);
  if (supabase) {
    const now = new Date().toISOString();
    const { error: ledgerError } = await supabase.from("email_messages").upsert({
      user_id: userId, recipient: to, subject: email.subject, message_type: "staff_role", deduplication_key: key,
      status: error ? "failed" : "accepted", attempt_count: 1, provider_message_id: providerId,
      preview_text: email.text.slice(0, 4000), last_error: error, accepted_at: error ? null : now, failed_at: error ? now : null,
      expires_at: now, next_attempt_at: now,
    }, { onConflict: "deduplication_key", ignoreDuplicates: true });
    if (ledgerError) console.error("[staff] Could not record the role email:", ledgerError.message);
  }
  return error ? "failed" : "sent";
}
