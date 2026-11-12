import type { SupabaseClient } from "@supabase/supabase-js";
import { PRECHECK_MAX, UNREVIEWED_SECTIONS, isReviewable } from "../lib/page-review-types";
import { SITEMAP_SECTIONS, sitemapEntries, type SitemapSection } from "./sitemap.server";
import { reviewKind, reviewPath, sectionOf } from "./page-reviews.server";
import { checkPage } from "./page-check.server";

/**
 * Pre-checking: staff queue a batch of pages nobody has reviewed or checked (the reviews page's "Pre-check"), the
 * five-minute cron runs the check on a few at a time, and "Ready to review" then walks through the checked pages
 * without waiting on each check. The queue is page_reviews.check_requested_at.
 */
/** Per cron run: checks take about a minute each, so a few at once, a few rounds per run. */
const PER_RUN = 15, AT_ONCE = 5;

/** Queues up to `count` random pages of a kind that nobody has reviewed, checked or queued. Returns how many. */
export async function queuePrecheck(supabase: SupabaseClient, section: SitemapSection | "any", count: number): Promise<number> {
  const n = Math.max(1, Math.min(PRECHECK_MAX, Math.floor(count)));
  const sections = section === "any"
    ? SITEMAP_SECTIONS.filter((s) => !(UNREVIEWED_SECTIONS as readonly string[]).includes(s))
    : [section];
  const lists = await Promise.all(sections.map((s) => sitemapEntries(supabase, s).catch(() => [])));
  const entries = [...new Set(lists.flat().map((e) => reviewPath(e.path)).filter((p): p is string => !!p && !p.includes("?") && isReviewable(p)))];
  const { data } = await supabase.from("page_reviews").select("path").limit(20000);
  const seen = new Set((data || []).map((r: { path: string }) => r.path));
  const open = entries.filter((p) => !seen.has(p));
  // A random sample, so a batch isn't all one corner of the site.
  for (let i = open.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [open[i], open[j]] = [open[j], open[i]];
  }
  const picked = open.slice(0, n);
  if (!picked.length) return 0;
  const at = new Date().toISOString();
  const { error } = await supabase.from("page_reviews")
    .upsert(picked.map((path) => ({ path, kind: reviewKind(path), check_requested_at: at })), { onConflict: "path", ignoreDuplicates: true });
  if (error) throw new Error("Could not queue the pages.");
  return picked.length;
}

/** Checked pages still in the public review inventory, oldest first. A merged/renamed/hidden page's
 * historical review stays intact, but must not keep sending staff through a redirect to a page they finished.
 * Use the same inventory as queuePrecheck, and the same list for both the counter and Next. */
async function readyCheckedPaths(supabase: SupabaseClient): Promise<string[]> {
  const rows: { path: string }[] = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await supabase.from("page_reviews").select("path")
      .is("status", null).is("check_requested_at", null).not("ai_checked_at", "is", null)
      .order("ai_checked_at", { ascending: true }).order("path", { ascending: true }).range(offset, offset + 999);
    if (error) throw new Error("Could not load checked pages.");
    rows.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  if (!rows.length) return [];
  const sections = new Set<SitemapSection>(["pages"]);
  for (const { path } of rows) {
    const section = sectionOf(path);
    if (section) sections.add(section);
  }
  // Do not turn a failed inventory read into an apparently empty/finished queue.
  const lists = await Promise.all([...sections].map((section) => sitemapEntries(supabase, section)));
  const current = new Set(lists.flat().map((entry) => reviewPath(entry.path)).filter((path) => path && isReviewable(path)));
  return rows.map(({ path }) => path).filter((path) => current.has(path));
}

/** How the queue stands: pages waiting for their check, and current checked pages nobody has reviewed yet. */
export async function precheckState(supabase: SupabaseClient) {
  const [queued, ready] = await Promise.all([
    supabase.from("page_reviews").select("path", { count: "exact", head: true }).not("check_requested_at", "is", null),
    readyCheckedPaths(supabase),
  ]);
  if (queued.error) throw new Error("Could not load queued pages.");
  return { queued: queued.count ?? 0, ready: ready.length };
}

/** The next current checked page nobody has reviewed, excluding the page just finished or skipped. */
export async function nextCheckedPath(supabase: SupabaseClient, from: string | null): Promise<string | null> {
  return (await readyCheckedPaths(supabase)).find((path) => path !== from) ?? null;
}

/** The cron's share of the queue: checks the oldest queued pages, a few at once, and clears each one's mark. */
export async function runPrecheckQueue(supabase: SupabaseClient, origin: string) {
  const { data } = await supabase.from("page_reviews").select("path").not("check_requested_at", "is", null)
    .order("check_requested_at", { ascending: true }).limit(PER_RUN);
  const paths = (data || []).map((r: { path: string }) => r.path);
  let checked = 0, failed = 0;
  const work = async () => {
    for (let path = paths.shift(); path; path = paths.shift()) {
      try {
        await checkPage(supabase, origin, path);
        checked++;
      } catch (error) {
        // Off the queue either way: a page whose check fails is left for a person to check from its review bar.
        failed++;
        console.error("[Pre-check]", path, error instanceof Error ? error.message : error);
      }
      await supabase.from("page_reviews").update({ check_requested_at: null }).eq("path", path);
    }
  };
  await Promise.all(Array.from({ length: AT_ONCE }, work));
  return { checked, failed };
}
