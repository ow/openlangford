import type { SupabaseClient } from "@supabase/supabase-js";
import type { PageFlag } from "../lib/page-review-types";

/**
 * Pages a person has checked, for "Recent updates". Only pages marked reviewed whose every flag is resolved: fixed,
 * or rated not a problem. A page a later check flags again drops off until it's resolved. Who reviewed it, and any
 * notes, stay in page_reviews (admin-only table); only the page, its title and the day leave this module.
 */
export type ReviewedPage = { path: string; title: string; kind: "topic" | "meeting"; reviewedAt: string };

const LIMIT = 300;

export function isResolved(flags: PageFlag[] | null | undefined): boolean {
  return (flags || []).every((f) => f.fixed || f.verdict === "disagree");
}

export async function getReviewedPages(supabase: SupabaseClient): Promise<ReviewedPage[]> {
  const { data, error } = await supabase.from("page_reviews").select("path, kind, title, ai_flags, reviewed_at")
    .eq("status", "reviewed").not("reviewed_at", "is", null).order("reviewed_at", { ascending: false }).limit(LIMIT);
  if (error) throw error;
  const rows = ((data || []) as { path: string; kind: string; title: string | null; ai_flags: PageFlag[] | null; reviewed_at: string }[])
    .filter((r) => isResolved(r.ai_flags) && (r.kind === "matters" || r.kind === "meetings"));
  // A topic since merged into another, or hidden, is no longer the page that was reviewed.
  const slugs = rows.filter((r) => r.kind === "matters").map((r) => r.path.slice("/matters/".length));
  const topics = new Map<string, { title: string; merged_into: number | null; meta: Record<string, any> | null }>();
  for (let i = 0; i < slugs.length; i += 100) {
    const { data: matters, error: mErr } = await supabase.from("matters").select("slug, title, merged_into, meta").in("slug", slugs.slice(i, i + 100));
    if (mErr) throw mErr;
    for (const m of (matters || []) as any[]) topics.set(m.slug, m);
  }
  return rows.flatMap((r): ReviewedPage[] => {
    if (r.kind === "meetings") return [{ path: r.path, title: r.title || "Meeting", kind: "meeting", reviewedAt: r.reviewed_at }];
    const topic = topics.get(r.path.slice("/matters/".length));
    if (!topic || topic.merged_into || topic.meta?.hidden) return [];
    return [{ path: r.path, title: topic.meta?.display_title || topic.title || r.title || "Topic", kind: "topic", reviewedAt: r.reviewed_at }];
  });
}
