import type { SupabaseClient } from "@supabase/supabase-js";
import type { StaffAction } from "./staff.server";

export const AUDIT_PAGE_SIZE = 50;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type AuditFilters = { person: string; action: string; q: string; page: number };
export type AuditRow = StaffAction & { user_id: string };
export type AuditPerson = { id: string; label: string };

export function auditFilters(url: URL): AuditFilters {
  const person = url.searchParams.get("person") || "";
  const page = Math.min(Math.max(Number.parseInt(url.searchParams.get("page") || "1", 10) || 1, 1), 1000);
  return {
    person: UUID.test(person) ? person : "",
    action: (url.searchParams.get("action") || "").slice(0, 100),
    q: (url.searchParams.get("q") || "").trim().slice(0, 200),
    page,
  };
}

/** Everyone's staff actions, newest first, with the people and action names to filter by. */
export async function getAuditPage(supabase: SupabaseClient, filters: AuditFilters) {
  let query = supabase.from("staff_actions")
    .select("id, user_id, role, path, action, detail, created_at", { count: "exact" })
    .order("created_at", { ascending: false })
    .range((filters.page - 1) * AUDIT_PAGE_SIZE, filters.page * AUDIT_PAGE_SIZE - 1);
  if (filters.person) query = query.eq("user_id", filters.person);
  if (filters.action === "agent") query = query.like("action", "agent:%");
  else if (filters.action) query = query.eq("action", filters.action);
  if (filters.q) {
    const like = `%${filters.q.replace(/[\\%_,()]/g, (c) => `\\${c}`)}%`;
    query = query.or(`path.ilike.${like},detail->>path.ilike.${like}`);
  }
  const [page, seen] = await Promise.all([
    query,
    supabase.from("staff_actions").select("user_id, action").order("created_at", { ascending: false }).limit(20000),
  ]);
  if (page.error) throw page.error;
  if (seen.error) throw seen.error;
  const ids = [...new Set((seen.data || []).map((r) => r.user_id as string))];
  const actions = [...new Set((seen.data || []).map((r) => r.action as string | null)
    .filter((a): a is string => !!a && !a.startsWith("agent:")))].sort();
  const people = await staffPeople(supabase, ids);
  const total = page.count ?? 0;
  return {
    rows: (page.data || []) as AuditRow[],
    total,
    hasMore: total > filters.page * AUDIT_PAGE_SIZE,
    people,
    actions,
  };
}

/** Display names (else email) for the staff who appear in the log. Admins only: emails are shown in full. */
async function staffPeople(supabase: SupabaseClient, ids: string[]): Promise<AuditPerson[]> {
  if (!ids.length) return [];
  const [{ data: profiles }, users] = await Promise.all([
    supabase.from("user_profiles").select("id, display_name").in("id", ids),
    Promise.all(ids.map((id) => supabase.auth.admin.getUserById(id).then((r) => r.data.user).catch(() => null))),
  ]);
  const names = new Map((profiles || []).map((p: { id: string; display_name: string | null }) => [p.id, p.display_name]));
  return ids.map((id, i) => ({ id, label: names.get(id)?.trim() || users[i]?.email || "Unknown account" }))
    .sort((a, b) => a.label.localeCompare(b.label));
}
