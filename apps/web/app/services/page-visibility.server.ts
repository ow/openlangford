import type { SupabaseClient } from "@supabase/supabase-js";
import { getStaffRole } from "../lib/auth.server";
import { createSupabaseServerClient, getSupabaseAdminClient } from "../lib/supabase.server";
import { getPageReview, setInternalNote } from "./page-reviews.server";
import { matterForPath, setTopicHidden, topicHidden } from "./page-links.server";
import { PRIVATE } from "../lib/cache-policy";

/** "Hide page" from the review bar: the page is "not found" for the public; staff still see it, to unhide it.
 * Topics keep their own flag (matters.meta.hidden = "staff"); other pages are listed in hidden_pages. */
export type HiddenTable = "meetings" | "properties" | "people" | "elections";

const SECTION_TABLE: Record<string, HiddenTable> = {
  meetings: "meetings", properties: "properties", participants: "people", elections: "elections",
};

type PageRecord = { table: "matters" | HiddenTable; id: number };

/** The record a reviewable page shows: /meetings/<slug or id>, /properties/<slug>, /participants/…, /elections/…, /matters/…. */
export async function pageRecord(supabase: SupabaseClient, path: string): Promise<PageRecord | null> {
  const [, section, param] = path.match(/^\/([a-z]+)\/([^/]+)$/) || [];
  if (!section || !param) return null;
  if (section === "matters") {
    const id = await matterForPath(supabase, path);
    return id ? { table: "matters", id } : null;
  }
  const table = SECTION_TABLE[section];
  if (!table) return null;
  const slug = decodeURIComponent(param).toLowerCase();
  const query = supabase.from(table).select("id");
  const { data } = await (/^\d+$/.test(slug) && table !== "properties" ? query.eq("id", Number(slug)) : query.eq("slug", slug)).limit(1).maybeSingle();
  return data ? { table, id: (data as { id: number }).id } : null;
}

export async function isPageHidden(supabase: SupabaseClient, path: string): Promise<boolean> {
  const record = await pageRecord(supabase, path);
  if (!record) return false;
  return record.table === "matters" ? topicHidden(supabase, record.id) : isRecordHidden(supabase, record.table, record.id);
}

/** Hide (with the reason, kept as the page's internal note) or unhide a page. */
export async function setPageHidden(supabase: SupabaseClient, path: string, hidden: boolean,
  { note, userId, title }: { note?: string; userId: string; title: string | null }) {
  const record = await pageRecord(supabase, path);
  if (!record) throw new Error("Could not find what this page shows.");
  const reason = (note || "").trim();
  if (hidden && !reason) throw new Error("Could not hide the page: say why in the note.");
  if (record.table === "matters") await setTopicHidden(supabase, record.id, hidden, userId);
  else if (hidden) {
    const { error } = await supabase.from("hidden_pages").upsert(
      { record_table: record.table, record_id: record.id, path, hidden_by: userId, hidden_at: new Date().toISOString() },
      { onConflict: "record_table,record_id" });
    if (error) throw new Error("Could not hide the page.");
  } else {
    const { error } = await supabase.from("hidden_pages").delete().eq("record_table", record.table).eq("record_id", record.id);
    if (error) throw new Error("Could not unhide the page.");
  }
  if (hidden) {
    // The reason goes first; whatever the note said before stays below it.
    const before = (await getPageReview(supabase, path))?.internal_note?.trim();
    await setInternalNote(supabase, path, [`Hidden from the public: ${reason}`, before].filter(Boolean).join("\n\n"), userId, title);
  }
}

/** In a page's loader, once it knows the record: a hidden page is a plain 404 unless the viewer is staff. */
export async function notFoundIfHidden(request: Request, table: HiddenTable, id: number | string) {
  if (!(await isRecordHidden(getSupabaseAdminClient(), table, id))) return;
  if (await viewerIsStaff(request)) return;
  throw new Response("Not Found", { status: 404, headers: { "X-Robots-Tag": "noindex", "Cache-Control": PRIVATE } });
}

/** A failed lookup counts as not hidden: it shows the page rather than taking a public one down. */
export async function isRecordHidden(supabase: SupabaseClient, table: HiddenTable, id: number | string) {
  // page_hidden() answers for any client, so public routes that never use admin access can ask too.
  const { data, error } = await supabase.rpc("page_hidden", { p_table: table, p_id: Number(id) });
  return !error && data === true;
}

export async function viewerIsStaff(request: Request) {
  const { data: { user } } = await createSupabaseServerClient(request).supabase.auth.getUser();
  return !!(await getStaffRole(user));
}
