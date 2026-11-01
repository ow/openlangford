import type { SupabaseClient } from "@supabase/supabase-js";

export type PageReviewStatus = "reviewed" | "needs_work";
export type PageReview = {
  path: string;
  kind: string;
  title: string | null;
  status: PageReviewStatus;
  note: string | null;
  reviewed_at: string;
};

const COLUMNS = "path, kind, title, status, note, reviewed_at";

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

export async function clearPageReview(supabase: SupabaseClient, path: string) {
  const { error } = await supabase.from("page_reviews").delete().eq("path", path);
  if (error) throw new Error("Could not clear the page review.");
}

export async function listPageReviews(supabase: SupabaseClient, status: PageReviewStatus | null) {
  let query = supabase.from("page_reviews").select(COLUMNS).order("reviewed_at", { ascending: false }).limit(500);
  if (status) query = query.eq("status", status);
  const [{ data, error }, counts] = await Promise.all([
    query,
    supabase.from("page_reviews").select("kind, status").limit(10000),
  ]);
  if (error || counts.error) throw new Error("Could not load page reviews.");
  const byKind: Record<string, { reviewed: number; needs_work: number }> = {};
  for (const row of (counts.data || []) as { kind: string; status: PageReviewStatus }[]) {
    byKind[row.kind] ??= { reviewed: 0, needs_work: 0 };
    byKind[row.kind][row.status] += 1;
  }
  return { reviews: (data || []) as PageReview[], byKind };
}
