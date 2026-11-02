import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { getAiClient } from "./ai/index.server";
import { renderPage } from "../lib/page-render.server";
import { reviewKind } from "./page-reviews.server";
import type { FlagProblem, FlagVerdict, PageFlag } from "../lib/page-review-types";

/**
 * A reader's check of one public page: the page is rendered as a signed-out visitor sees it, and the model is
 * asked, entry by entry, what a resident would trip over (why is this here? is it about this at all?).
 * An admin rates each flag right or wrong; the latest ratings go back into the prompt, so the check learns
 * what counts as a real problem. Used by the admin review bar and by agents through /api/v1/admin/page-checks.
 */

export const FLAG_PROBLEMS: Record<FlagProblem, string> = {
  unclear_why: "You can't tell from what's shown why this entry is on this page.",
  generic_text: "The text is generic (\"Public hearings were held\") and says nothing about this page's subject.",
  different_story: "It's about a different property, permit, project or decision than this page.",
  duplicate: "It repeats another entry on the page.",
  wrong_detail: "A date, name, number or outcome contradicts the rest of the page.",
};
export type { FlagProblem, FlagVerdict, PageFlag };
export type PageCheck = { path: string; flags: PageFlag[]; page_issue: string | null; summary: string; model: string; checked_at: string; entries: number };

export type PageEntry = { key: string; text: string };
export type ReadPage = { title: string; heading: string; description: string; entries: PageEntry[]; body: string };

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", hellip: "…", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", ndash: "–", mdash: "—" };

function plain(html: string) {
  return html
    .replace(/<(script|style|svg|noscript)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/(p|div|li|h\d|blockquote|br)>|<br\s*\/?>/gi, " · ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) =>
      code[0] === "#" ? String.fromCodePoint(code[1].toLowerCase() === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10))
        : ENTITIES[code.toLowerCase()] ?? whole)
    .replace(/\s+/g, " ")
    .replace(/(?:\s*·\s*)+/g, " · ")
    .replace(/^ · | · $/g, "")
    .trim();
}

/** What a reader sees: the title, heading, description, and each timeline entry (by its anchor key). */
export function readPage(html: string): ReadPage {
  const title = plain(html.match(/<title>([\s\S]*?)<\/title>/i)?.[1] || "");
  const heading = plain(html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1] || "");
  const description = plain(html.match(/<meta\s+name="description"\s+content="([^"]*)"/i)?.[1] || "");
  const starts = [...html.matchAll(/<li\b[^>]*\bid="timeline-([^"]+)"[^>]*>/g)];
  const entries = starts.map((m, i) => {
    const from = m.index! + m[0].length;
    const next = starts[i + 1]?.index ?? html.indexOf("</ol>", from);
    return { key: m[1], text: plain(html.slice(from, next === -1 ? undefined : next)).slice(0, 900) };
  }).filter(e => e.text);
  const main = html.match(/<main\b[^>]*>([\s\S]*)<\/main>/i)?.[1] || html;
  return { title, heading, description, entries, body: entries.length ? "" : plain(main).slice(0, 14000) };
}

const CheckSchema = z.object({
  summary: z.string().describe("Two plain sentences for the editor: what this page is about, and whether its entries hang together as one story (name any weak spots even if not worth a flag)."),
  page_issue: z.string().nullable().describe("A problem with the page as a whole (e.g. it lumps unrelated subjects together), or null."),
  flags: z.array(z.object({
    key: z.string().nullable().describe("The entry's key exactly as given, or null for a problem outside the entries."),
    problem: z.enum(Object.keys(FLAG_PROBLEMS) as [FlagProblem, ...FlagProblem[]]),
    reason: z.string().describe("One plain sentence a resident would understand."),
  })),
});

type Example = { problem: FlagProblem; reason: string; excerpt: string; verdict: FlagVerdict };

/** The most recent rated flags from any page: what the admin agreed was a problem, and what wasn't. */
export async function calibrationExamples(supabase: SupabaseClient, limit = 12): Promise<Example[]> {
  const { data } = await supabase.from("page_reviews").select("ai_flags").not("ai_flags", "is", null)
    .order("ai_checked_at", { ascending: false }).limit(200);
  const rated = ((data || []) as { ai_flags: PageFlag[] | null }[])
    .flatMap(row => (row.ai_flags || []).filter(f => f.verdict))
    .map(f => ({ problem: f.problem, reason: f.reason, excerpt: f.excerpt.slice(0, 220), verdict: f.verdict! }));
  const agree = rated.filter(f => f.verdict === "agree").slice(0, limit);
  const disagree = rated.filter(f => f.verdict === "disagree").slice(0, limit);
  return [...agree, ...disagree];
}

export function checkPrompt(page: ReadPage, examples: Example[]) {
  const problems = Object.entries(FLAG_PROBLEMS).map(([k, v]) => `- ${k}: ${v}`).join("\n");
  const content = page.entries.length
    ? page.entries.map(e => `[${e.key}] ${e.text}`).join("\n\n")
    : page.body;
  const calibration = examples.length
    ? `\n\nAn editor rated earlier flags. Flag what they agreed with; don't flag the kind of thing they rejected.\n` +
      examples.map(e => `- ${e.verdict === "agree" ? "AGREED" : "REJECTED"} ${e.problem}: ${e.reason} (entry: "${e.excerpt}")`).join("\n")
    : "";
  return `You're a Langford resident reading this page on Open Langford, a site that follows City council. Point out what
would confuse or mislead you. Only flag clear problems a careful reader would notice; most entries are fine,
and a page with nothing wrong gets no flags. A timeline entry may be a small mention of this subject inside a
meeting about something else; that's fine if the entry shows why it's there.

Problems:
${problems}${calibration}

Page: ${page.title}
Heading: ${page.heading}
Description: ${page.description}

${page.entries.length ? "Timeline entries (newest first), each with its key:" : "Page text:"}
${content}`;
}

/** Check one page and store the result on its page_reviews row (keeping any review status and note). */
export async function checkPage(supabase: SupabaseClient, origin: string, path: string): Promise<PageCheck> {
  const page = readPage(await renderPage(origin, path));
  const examples = await calibrationExamples(supabase);
  const result = await getAiClient().json({
    stage: "review",  // REVIEW_AI_MODEL, else the site's AI_MODEL
    prompt: checkPrompt(page, examples),
    schema: CheckSchema,
    schemaName: "page_check",
  });
  const byKey = new Map(page.entries.map(e => [e.key, e.text]));
  const flags: PageFlag[] = result.data.flags
    .filter(f => f.key === null || byKey.has(f.key))
    .map(f => ({ key: f.key, problem: f.problem, reason: f.reason, excerpt: (f.key && byKey.get(f.key)) || page.heading, verdict: null }));
  const checked_at = new Date().toISOString();
  const { error } = await supabase.from("page_reviews").upsert({
    path, kind: reviewKind(path), title: page.heading || page.title || null,
    ai_flags: flags, ai_page_issue: result.data.page_issue, ai_summary: result.data.summary,
    ai_entries: page.entries.length, ai_model: result.model, ai_checked_at: checked_at,
  }, { onConflict: "path" });
  if (error) throw new Error("Could not save the page check.");
  return { path, flags, page_issue: result.data.page_issue, summary: result.data.summary, model: result.model, checked_at, entries: page.entries.length };
}

/** An admin's verdict on one flag (by its position in the stored list); null clears it. */
export async function rateFlag(supabase: SupabaseClient, path: string, index: number, verdict: FlagVerdict | null) {
  const { data, error } = await supabase.from("page_reviews").select("ai_flags").eq("path", path).maybeSingle();
  if (error || !data?.ai_flags || !Array.isArray(data.ai_flags) || !data.ai_flags[index]) throw new Error("No such flag.");
  const flags = [...(data.ai_flags as PageFlag[])];
  flags[index] = { ...flags[index], verdict };
  const saved = await supabase.from("page_reviews").update({ ai_flags: flags }).eq("path", path);
  if (saved.error) throw new Error("Could not save the rating.");
  return flags;
}

/** A random public matter page nobody has reviewed or checked yet. */
export async function randomUncheckedMatterPath(supabase: SupabaseClient): Promise<string | null> {
  const visible = () => supabase.from("matters").select("slug", { count: "exact" })
    .not("slug", "is", null).is("meta->>canonical_matter_id", null).or("meta->>hidden.is.null,meta->>hidden.neq.container");
  const { count } = await visible().limit(1);
  if (!count) return null;
  const { data: seen } = await supabase.from("page_reviews").select("path").eq("kind", "matters").limit(10000);
  const done = new Set((seen || []).map((r: { path: string }) => r.path));
  for (let attempt = 0; attempt < 8; attempt++) {
    const offset = Math.floor(Math.random() * count);
    const { data } = await visible().order("id").range(offset, offset);
    const slug = (data?.[0] as { slug?: string } | undefined)?.slug;
    if (slug && !done.has(`/matters/${slug}`)) return `/matters/${slug}`;
  }
  return null;
}

/** Marks the flags on one entry resolved (the entry was removed, or staff handled it some other way). */
export async function resolveFlags(supabase: SupabaseClient, path: string, match: { key?: string; index?: number }) {
  const { data } = await supabase.from("page_reviews").select("ai_flags").eq("path", path).maybeSingle();
  const flags = (data?.ai_flags || []) as PageFlag[];
  const hit = (f: PageFlag, i: number) => (match.index !== undefined ? i === match.index : !!match.key && f.key === match.key);
  if (!flags.some(hit)) return;
  const updated = flags.map((f, i) => (hit(f, i) ? { ...f, verdict: "agree" as const, fixed: true } : f));
  const saved = await supabase.from("page_reviews").update({ ai_flags: updated }).eq("path", path);
  if (saved.error) throw new Error("Could not save the flag.");
}

/** Staff's instruction for the fix agent on one flag. Writing one agrees the flag is a problem. */
export async function setFlagNote(supabase: SupabaseClient, path: string, index: number, note: string) {
  const { data } = await supabase.from("page_reviews").select("ai_flags").eq("path", path).maybeSingle();
  const flags = [...((data?.ai_flags || []) as PageFlag[])];
  if (!flags[index]) throw new Error("No such flag.");
  const text = note.trim().slice(0, 1000) || null;
  flags[index] = { ...flags[index], note: text, ...(text ? { verdict: "agree" as const } : {}) };
  const saved = await supabase.from("page_reviews").update({ ai_flags: flags }).eq("path", path);
  if (saved.error) throw new Error("Could not save the instruction.");
}
