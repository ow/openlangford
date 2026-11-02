import type { SupabaseClient } from "@supabase/supabase-js";
import { UNREVIEWED_SECTIONS, isReviewable, unresolvedFlags, type PageFlag, type PageReview, type PageReviewStatus } from "../lib/page-review-types";
import { SITEMAP_SECTIONS, sitemapEntries, type SitemapSection } from "./sitemap.server";

export type { PageReview, PageReviewStatus } from "../lib/page-review-types";

const COLUMNS = "path, kind, title, status, note, reviewed_at, ai_flags, ai_page_issue, ai_summary, ai_entries, ai_checked_at, agent_note, agent_at";

/** The page a review is about: its path alone, no query string or trailing slash ("/matters/x"). */
export function reviewPath(value: string | null | undefined): string | null {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return null;
  if (!isReviewable(value.split(/[?#]/)[0])) return null;
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
  else if (filter === "needs_work") query = query.in("status", ["needs_work", "fixing"]);
  else if (filter) query = query.eq("status", filter);
  const [{ data, error }, all] = await Promise.all([
    query,
    supabase.from("page_reviews").select("path, kind, status, ai_flags").limit(10000),
  ]);
  if (error || all.error) throw new Error("Could not load page reviews.");
  const rows = (all.data || []) as { path: string; kind: string; status: PageReviewStatus | null; ai_flags: PageFlag[] | null }[];
  const byKind: Record<string, { reviewed: number; needs_work: number; checked: number }> = {};
  const bucket = (status: PageReviewStatus) => (status === "reviewed" ? "reviewed" : "needs_work");
  for (const row of rows) {
    const n = (byKind[row.kind] ??= { reviewed: 0, needs_work: 0, checked: 0 });
    if (row.status) n[bucket(row.status)] += 1;
    if (row.ai_flags) n.checked += 1;
  }
  const rated = rows.flatMap(r => (r.ai_flags || []).filter(f => f.verdict));
  // "Open flags": checked pages with a flag still to rate or fix (resolved ones have nothing left to do).
  const listed = (data || []) as PageReview[];
  return {
    reviews: filter === "flagged" ? listed.filter((r) => unresolvedFlags(r.ai_flags).length > 0) : listed,
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
  const reviewed = SITEMAP_SECTIONS.filter((s) => !(UNREVIEWED_SECTIONS as readonly string[]).includes(s));
  const sections = await Promise.all(reviewed.map(async (section) => {
    // Only the pages the tool reviews: a section's list pages ("/meetings?year=2019") don't count.
    const entries = (await sitemapEntries(supabase, section).catch(() => [])).filter((e) => reviewPath(e.path));
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

/** A random page nobody has reviewed or checked yet: of one kind (a sitemap section), or of any kind (every page
 * equally likely), or null when none are left. */
export async function randomUnreviewedPath(supabase: SupabaseClient, section: SitemapSection | "any"): Promise<string | null> {
  const sections = section === "any"
    ? SITEMAP_SECTIONS.filter((s) => !(UNREVIEWED_SECTIONS as readonly string[]).includes(s))
    : [section];
  const lists = await Promise.all(sections.map((s) => sitemapEntries(supabase, s).catch(() => [])));
  const entries = lists.flat().map((e) => reviewPath(e.path)).filter((p): p is string => !!p && !p.includes("?"));
  if (!entries.length) return null;
  const { data } = await supabase.from("page_reviews").select("path").limit(20000);
  const seen = new Set((data || []).map((r: { path: string }) => r.path));
  const open = entries.filter((p) => !seen.has(p));
  return open.length ? open[Math.floor(Math.random() * open.length)] : null;
}

/** The sitemap section a page belongs to (for "next page of the same kind"), or null. */
export function sectionOf(path: string): SitemapSection | null {
  const first = path.split("/")[1] || "";
  if (/^meetings$/.test(first)) return /\/documents\//.test(path) ? "documents" : "meetings";
  const map: Record<string, SitemapSection> = { matters: "matters", people: "people", properties: "properties", bylaws: "bylaws", participants: "participants", elections: "elections" };
  return map[first] ?? null;
}
