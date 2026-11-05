import type { SupabaseClient } from "@supabase/supabase-js";
import { UNREVIEWED_SECTIONS, isReviewable, unresolvedFlags, type PageFlag, type PageReview, type PageReviewStatus } from "../lib/page-review-types";
import { SITEMAP_SECTIONS, sitemapEntries, type SitemapSection } from "./sitemap.server";
import { todayKey } from "../lib/pipeline-status";

export type { PageReview, PageReviewStatus } from "../lib/page-review-types";

const COLUMNS = "path, kind, title, status, note, reviewed_at, ai_flags, ai_page_issue, ai_summary, ai_entries, ai_checked_at, agent_note, agent_at, internal_note, internal_note_at";

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

/** How long a fix may run before the page stops saying the agent is working (a run that died, in a deploy say). */
const STALE_FIX_MS = 10 * 60_000;

export async function getPageReview(supabase: SupabaseClient, path: string): Promise<PageReview | null> {
  const { data, error } = await supabase.from("page_reviews").select(COLUMNS).eq("path", path).maybeSingle();
  if (error) throw new Error("Could not load the page review.");
  const review = data as PageReview | null;
  // Fix sets "fixing" (stamping reviewed_at); the agent always finishes with "fixed" or "needs work". Still fixing
  // long after: the run stopped without finishing, so say so rather than show the agent working forever.
  if (review?.status === "fixing" && review.reviewed_at && Date.now() - new Date(review.reviewed_at).getTime() > STALE_FIX_MS) {
    const agent_note = "The agent stopped without finishing. Press Fix to try again.";
    await supabase.from("page_reviews").update({ status: "needs_work", agent_note, agent_at: new Date().toISOString() })
      .eq("path", path).eq("status", "fixing");
    return { ...review, status: "needs_work", agent_note };
  }
  return review;
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

/** Staff's internal note on a page (empty clears it). Kept apart from the review: clearing a review keeps it. */
export async function setInternalNote(supabase: SupabaseClient, path: string, note: string, userId: string, title: string | null) {
  const text = note.trim().slice(0, 4000) || null;
  const { error } = await supabase.from("page_reviews").upsert({
    path, kind: reviewKind(path), ...(title ? { title: title.replace(/\s*\|\s*Open Langford\s*$/, "").slice(0, 300) } : {}),
    internal_note: text, internal_note_by: text ? userId : null, internal_note_at: text ? new Date().toISOString() : null,
  }, { onConflict: "path" });
  if (error) throw new Error("Could not save the note.");
}

/** Clears the review status and note; a stored check stays (its ratings calibrate later checks). */
export async function clearPageReview(supabase: SupabaseClient, path: string) {
  const { error } = await supabase.from("page_reviews")
    .update({ status: null, note: null, reviewed_by: null, reviewed_at: null }).eq("path", path);
  if (error) throw new Error("Could not clear the page review.");
}

/** "attention": what is waiting on staff (fixes to confirm, pages needing work, open flags). */
export type ReviewFilter = PageReviewStatus | "flagged" | "attention" | null;

export async function listPageReviews(supabase: SupabaseClient, filter: ReviewFilter) {
  let query = supabase.from("page_reviews").select(COLUMNS)
    .order("reviewed_at", { ascending: false, nullsFirst: false })
    .order("ai_checked_at", { ascending: false, nullsFirst: false }).limit(500);
  if (filter === "flagged") query = query.not("ai_flags", "is", null).neq("ai_flags", "[]");
  else if (filter === "attention") query = query.or("status.in.(fixed,needs_work,fixing),ai_flags.not.is.null");
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
    reviews: filter === "flagged" ? listed.filter((r) => unresolvedFlags(r.ai_flags).length > 0)
      : filter === "attention" ? listed.filter((r) => r.status !== "reviewed" && (!!r.status || unresolvedFlags(r.ai_flags).length > 0))
      : listed,
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

/** How many public pages are still waiting for a review, now and at the end of each of the last `days` days (the
 * admin home's burn-down), plus this week's reviews and agent fixes waiting to be confirmed. A page counts as
 * reviewed once a person has given it a status, the same rule as reviewCoverage. */
export async function reviewBurndown(supabase: SupabaseClient, now = new Date(), days = 30) {
  const kinds = SITEMAP_SECTIONS.filter((s) => !(UNREVIEWED_SECTIONS as readonly string[]).includes(s));
  const [lists, rows] = await Promise.all([
    Promise.all(kinds.map((s) => sitemapEntries(supabase, s).catch(() => []))),
    supabase.from("page_reviews").select("path, status, reviewed_at").not("status", "is", null).limit(20000),
  ]);
  if (rows.error) throw rows.error;
  const pages = new Set(lists.flat().map((e) => reviewPath(e.path)).filter((p): p is string => !!p));
  const done = (rows.data || []).filter((r: { path: string }) => pages.has(r.path));
  const doneDays = done.map((r: { reviewed_at: string | null }) => todayKey(new Date(r.reviewed_at || now)));
  const weekAgo = todayKey(new Date(now.getTime() - 6 * 86_400_000));
  const series = Array.from({ length: days }, (_, i) => {
    const day = todayKey(new Date(now.getTime() - (days - 1 - i) * 86_400_000));
    return { day, value: pages.size - doneDays.filter((d) => d <= day).length };
  });
  return {
    total: pages.size,
    left: pages.size - done.length,
    reviewedThisWeek: doneDays.filter((d) => d >= weekAgo).length,
    awaitingConfirmation: done.filter((r: { status: string }) => r.status === "fixed").length,
    series,
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
