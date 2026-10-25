import type { SupabaseClient } from "@supabase/supabase-js";
import { redirect } from "react-router";

type SlugTable = "meetings" | "matters" | "bylaws" | "elections";

export type ResolvedSlugRow = { id: number; slug: string };

/**
 * Current row for a meeting slug that was renamed (meeting_slug_history), or null.
 * Meeting slugs embed the date, so a date correction renames the slug and records the old one.
 */
export async function findMeetingBySlugHistory(
  supabase: SupabaseClient,
  slug: string,
): Promise<ResolvedSlugRow | null> {
  const { data: hist } = await supabase
    .from("meeting_slug_history")
    .select("meeting_id")
    .eq("old_slug", slug)
    .limit(1)
    .maybeSingle();
  if (!hist) return null;
  const { data } = await supabase.from("meetings").select("id, slug").eq("id", hist.meeting_id).maybeSingle();
  const row = data as ResolvedSlugRow | null;
  return row?.slug && row.slug !== slug ? row : null;
}

/**
 * Resolve a `:id` route param that should be a slug.
 *
 * - all-digit param (legacy id URL): look the row up by id and 301 to
 *   `buildPath(row)` + the original query string.
 * - otherwise: look up by slug; 404 if missing. Old id-prefixed matter/bylaw
 *   slugs ("1665-solid-waste-...") 301 to the current slug via their id.
 *
 * `buildPath` receives the row and should rebuild the full current URL
 * (including any sub-path such as "/explorer" or "/documents/12").
 *
 * With `redirectLegacy: false` the row is returned instead of redirecting,
 * for callers that compute a different final URL (matter aliases).
 */
export async function resolveSlugParam(
  supabase: SupabaseClient,
  table: SlugTable,
  param: string | undefined,
  request: Request,
  buildPath: (row: ResolvedSlugRow) => string,
  notFound = "Not Found",
  { redirectLegacy = true }: { redirectLegacy?: boolean } = {},
): Promise<ResolvedSlugRow> {
  if (!param) throw new Response(notFound, { status: 404 });
  const { search } = new URL(request.url);

  const byId = async (id: number) => {
    const { data } = await supabase.from(table).select("id, slug").eq("id", id).maybeSingle();
    return data as ResolvedSlugRow | null;
  };

  if (/^\d+$/.test(param)) {
    const row = await byId(Number(param));
    if (!row) throw new Response(notFound, { status: 404 });
    if (!row.slug || !redirectLegacy) return row; // no slug yet: serve on the id URL
    throw redirect(buildPath(row) + search, 301);
  }

  const slug = decodeURIComponent(param).toLowerCase();
  const { data } = await supabase.from(table).select("id, slug").eq("slug", slug).limit(1).maybeSingle();
  if (data) {
    const row = data as ResolvedSlugRow;
    if (param !== row.slug && redirectLegacy) throw redirect(buildPath(row) + search, 301);
    return row;
  }

  // Renamed meeting slug (date correction): 301 to the current slug, keeping sub-path and query.
  if (table === "meetings") {
    const row = await findMeetingBySlugHistory(supabase, slug);
    if (row) {
      if (!redirectLegacy) return row;
      throw redirect(buildPath(row) + search, 301);
    }
  }

  // Pre-47-10 matter/bylaw slugs were "{id}-{title}".
  const legacy = table === "matters" || table === "bylaws" ? /^(\d+)-/.exec(slug) : null;
  if (legacy) {
    const row = await byId(Number(legacy[1]));
    if (row?.slug && row.slug !== slug) {
      if (!redirectLegacy) return row;
      throw redirect(buildPath(row) + search, 301);
    }
  }
  throw new Response(notFound, { status: 404 });
}

// Batched meeting-slug fill helpers are client-safe; re-exported for existing server imports.
export { fillMeetingSlugs, withMeetingSlugs } from "./meeting-slugs";
