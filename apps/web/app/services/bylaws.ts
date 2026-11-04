import type { SupabaseClient } from "@supabase/supabase-js";
import type { Bylaw } from "../lib/types";
import { policyNumbers, type PolicyRow } from "../lib/policies";

export async function getBylaws(supabase: SupabaseClient) {
  const { data, error } = await supabase
    .from("bylaws")
    .select(
      "id, slug, title, bylaw_number, year, category, status, plain_english_summary",
    )
    .order("title", { ascending: true });

  if (error) throw error;
  return data as Bylaw[];
}

export async function getBylawById(supabase: SupabaseClient, id: string) {
  const { data, error } = await supabase
    .from("bylaws")
    .select(
      `
      *,
      matters (
        id,
        slug,
        title,
        status,
        identifier,
        plain_english_summary,
        merged_into,
        meta,
        agenda_items (
          id,
          meetings (
            meeting_date
          )
        )
      )
    `,
    )
    .eq("id", id)
    .single();

  if (error) throw error;
  // A topic merged into another can still hold the link to this bylaw (its main topic links a different one):
  // show the main topic instead, once.
  const merged = [...new Set(((data as any).matters || []).map((m: any) => m.merged_into).filter(Boolean))] as number[];
  if (merged.length) {
    const { data: mains, error: mainsError } = await supabase.from("matters")
      .select("id, slug, title, status, identifier, plain_english_summary, merged_into, meta, agenda_items(id, meetings(meeting_date))")
      .in("id", merged).is("merged_into", null);
    if (mainsError) throw mainsError;
    const own = ((data as any).matters || []).filter((m: any) => !m.merged_into);
    const seen = new Set(own.map((m: any) => m.id));
    (data as any).matters = [...own, ...(mains || []).filter((m: any) => !seen.has(m.id))];
  }
  return data as Bylaw;
}

/** Council policies: matters carrying a POL- number (there is no policies table). */
export async function getPolicies(supabase: SupabaseClient): Promise<PolicyRow[]> {
  const { data, error } = await supabase
    .from("matters")
    .select("id, slug, title, identifier, status, category, last_seen, plain_english_summary, meta")
    .ilike("identifier", "%POL-%")
    .is("merged_into", null)
    .is("meta->>hidden", null)
    .order("last_seen", { ascending: false, nullsFirst: false });

  if (error) throw error;
  return ((data || []) as any[])
    .filter((m) => policyNumbers(m.identifier).length > 0)
    .map((m) => ({
      ...m,
      // Only the fields the list shows; meta also carries timeline headlines etc.
      meta: m.meta ? { display_title: m.meta.display_title, status_line: m.meta.status_line } : null,
    })) as PolicyRow[];
}
