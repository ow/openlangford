import { redirect } from "react-router";
import type { SupabaseClient } from "@supabase/supabase-js";
import { personPath, personSlug } from "./people-paths";
import { throwIfFailed } from "./loader-errors";

export type ResolvedPerson = { id: number; name: string; slug: string | null };

/**
 * Resolve a `/people/:id` route param (slug or legacy numeric id).
 * Legacy numeric URLs 301 to the slug URL, preserving sub-path and query.
 */
export async function resolvePersonParam(
  supabase: SupabaseClient,
  param: string,
  request: Request,
  suffix = "",
  profilePath: typeof personPath = personPath,
): Promise<ResolvedPerson> {
  if (/^\d+$/.test(param)) {
    const { data, error } = await supabase
      .from("people")
      .select("id, name, slug")
      .eq("id", Number(param))
      .maybeSingle();
    throwIfFailed(error);
    if (!data) throw new Response("Person Not Found", { status: 404 });
    const { search } = new URL(request.url);
    throw redirect(profilePath(data, suffix) + search, 301);
  }

  const slug = param.toLowerCase();

  const { data: bySlug, error } = await supabase
    .from("people")
    .select("id, name, slug")
    .eq("slug", slug)
    .maybeSingle();
  throwIfFailed(error);
  if (bySlug) return bySlug as ResolvedPerson;

  // Fallback for rows without a stored slug: narrow by name, then match
  // the derived slug exactly.
  const pattern = `%${slug.split("-").filter(Boolean).join("%")}%`;
  const { data: candidates, error: candidatesError } = await supabase
    .from("people")
    .select("id, name, slug")
    .ilike("name", pattern)
    .order("id")
    .limit(50);
  throwIfFailed(candidatesError);
  const match = (candidates || []).find((p) => personSlug(p.name) === slug);
  if (!match) throw new Response("Person Not Found", { status: 404 });
  return match as ResolvedPerson;
}
