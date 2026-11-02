import type { SupabaseClient } from "@supabase/supabase-js";
import type { PageFlag, PageReview, PageReviewStatus } from "../lib/page-review-types";
import { SITEMAP_SECTIONS, sitemapEntries, type SitemapSection } from "./sitemap.server";

export type { PageReview, PageReviewStatus } from "../lib/page-review-types";

const COLUMNS = "path, kind, title, status, note, reviewed_at, ai_flags, ai_page_issue, ai_checked_at";

/** The page a review is about: its path alone, no query string or trailing slash ("/matters/x"). */
export function reviewPath(value: string | null | undefined): string | null {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return null;
  const path = value.split(/[?#]/)[0].replace(/\/+$/, "") || "/";
  return path.length <= 300 && !path.startsWith("/admin") ? path : null;
}

/** "matters", "meetings", "people" …, from the first part of the path. */
export function reviewKind(path: string) {
  return path.split("/")[1] || "home";
}

export async function getPageReview(supabase: SupabaseClient, path: string): Promise<PageReview | null> {
  const { data, error } = await supabase.from("page_reviews").select(COLUMNS).eq("path", path).maybeSingle();
  if (error) throw new Error("Could not load the page review.");
  return data as PageReview | null;
}

export async function setPageReview(supabase: SupabaseClient, review: {
  path: string; title: string | null; status: PageReviewStatus; note: string | null; userId: string;
}) {
  const { error } = await supabase.from("page_reviews").upsert({
    path: review.path,
    kind: reviewKind(review.path),
    title: review.title?.replace(/\s*\|\s*Open Langford\s*$/, "").slice(0, 300) || null,
    status: review.status,
    note: review.note?.trim().slice(0, 2000) || null,
    reviewed_by: review.userId,
    reviewed_at: new Date().toISOString(),
  });
  if (error) throw new Error("Could not save the page review.");
}

/** Clears the review status and note; a stored check stays (its ratings calibrate later checks). */
export async function clearPageReview(supabase: SupabaseClient, path: string) {
  const { error } = await supabase.from("page_reviews")
    .update({ status: null, note: null, reviewed_by: null, reviewed_at: null }).eq("path", path);
  if (error) throw new Error("Could not clear the page review.");
}

export type ReviewFilter = PageReviewStatus | "flagged" | null;

export async function listPageReviews(supabase: SupabaseClient, filter: ReviewFilter) {
  let query = supabase.from("page_reviews").select(COLUMNS)
    .order("reviewed_at", { ascending: false, nullsFirst: false })
    .order("ai_checked_at", { ascending: false, nullsFirst: false }).limit(500);
  if (filter === "flagged") query = query.not("ai_flags", "is", null).neq("ai_flags", "[]");
  else if (filter) query = query.eq("status", filter);
  const [{ data, error }, all] = await Promise.all([
    query,
    supabase.from("page_reviews").select("path, kind, status, ai_flags").limit(10000),
  ]);
  if (error || all.error) throw new Error("Could not load page reviews.");
  const rows = (all.data || []) as { path: string; kind: string; status: PageReviewStatus | null; ai_flags: PageFlag[] | null }[];
  const byKind: Record<string, { reviewed: number; needs_work: number; checked: number }> = {};
  for (const row of rows) {
    const n = (byKind[row.kind] ??= { reviewed: 0, needs_work: 0, checked: 0 });
    if (row.status) n[row.status] += 1;
    if (row.ai_flags) n.checked += 1;
  }
  const rated = rows.flatMap(r => (r.ai_flags || []).filter(f => f.verdict));
  return {
    reviews: (data || []) as PageReview[],
    rows,
    byKind,
    agreement: { rated: rated.length, agreed: rated.filter(f => f.verdict === "agree").length },
  };
}

const SECTION_LABELS: Record<SitemapSection, string> = {
  matters: "Topics", meetings: "Meetings", people: "People", properties: "Properties", bylaws: "Bylaws",
  documents: "Documents", participants: "Participants", elections: "Elections", pages: "Other pages",
};

/** Of every public page (the sitemap's lists), how many have been reviewed or checked, by kind of page. */
export async function reviewCoverage(supabase: SupabaseClient, rows: { path: string; status: PageReviewStatus | null; ai_flags: unknown }[]) {
  const byPath = new Map(rows.map(r => [r.path, r]));
  const sections = await Promise.all(SITEMAP_SECTIONS.map(async (section) => {
    const entries = await sitemapEntries(supabase, section).catch(() => []);
    let reviewed = 0, checked = 0;
    for (const entry of entries) {
      const row = byPath.get(reviewPath(entry.path) || "");
      if (row?.status) reviewed += 1;
      if (row?.ai_flags) checked += 1;
    }
    return { section, label: SECTION_LABELS[section], total: entries.length, reviewed, checked };
  }));
  const order: SitemapSection[] = ["matters", "meetings", "people", "properties", "bylaws", "documents", "participants", "elections", "pages"];
  const list = sections.filter(s => s.total > 0).sort((a, b) => order.indexOf(a.section) - order.indexOf(b.section));
  return {
    sections: list,
    total: list.reduce((n, s) => n + s.total, 0),
    reviewed: list.reduce((n, s) => n + s.reviewed, 0),
    checked: list.reduce((n, s) => n + s.checked, 0),
  };
}
