import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { getAiClient } from "./ai/index.server";
import { renderPage } from "../lib/page-render.server";
import { reviewKind } from "./page-reviews.server";
import type { FlagProblem, FlagVerdict, PageFlag } from "../lib/page-review-types";
import { approvedGuidance, examplesFor, recordExample } from "./review-learning.server";

/**
 * A reader's check of one public page: the page is rendered as a signed-out visitor sees it, and the model is
 * asked, entry by entry, what a resident would trip over (why is this here? is it about this at all?).
 * An admin rates each flag right or wrong; the latest ratings go back into the prompt, so the check learns
 * what counts as a real problem. Used by the admin review bar and by agents through /api/v1/admin/page-checks.
 */

export const FLAG_PROBLEMS: Record<FlagProblem, string> = {
  unclear_why: "You can't tell from what's shown why this entry is on this page.",
  generic_text: "The text could be about anything (\"Public hearings were held for bylaws (see subitems)\"), so a reader can't tell what happened to this subject. A line that doesn't repeat the page's subject is fine: on a page about one rezoning, \"Zoning amendment adopted\" is clear.",
  different_story: "It's about a different property, permit, project or decision than this page.",
  duplicate: "It repeats another entry on the page.",
  wrong_detail: "A date, name, number or outcome contradicts the rest of the page.",
  editor_issue: "Something an editor wants changed (added by staff, never by the check).",
};
/** What the check itself may flag: everything except staff's own issues. */
const CHECK_PROBLEMS = (Object.keys(FLAG_PROBLEMS) as FlagProblem[]).filter((p) => p !== "editor_issue");
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
const PAGE_CAP = 800_000;

export function readPage(html: string): ReadPage {
  const title = plain(html.match(/<title>([\s\S]*?)<\/title>/i)?.[1] || "");
  const heading = plain(html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1] || "");
  const description = plain(html.match(/<meta\s+name="description"\s+content="([^"]*)"/i)?.[1] || "");
  const starts = [...html.matchAll(/<li\b[^>]*\bid="timeline-([^"]+)"[^>]*>/g)];
  const entries = starts.map((m, i) => {
    const from = m.index! + m[0].length;
    const next = starts[i + 1]?.index ?? html.indexOf("</ol>", from);
    return { key: m[1], text: plain(html.slice(from, next === -1 ? undefined : next)) };
  }).filter(e => e.text);
  const main = html.match(/<main\b[^>]*>([\s\S]*)<\/main>/i)?.[1] || html;
  // Whole pages: a long meeting's motions and votes are at the bottom. The cap only guards against a runaway
  // page (about 200,000 tokens), far beyond any real one.
  const body = entries.length ? "" : plain(main);
  return { title, heading, description, entries, body: body.length > PAGE_CAP ? `${body.slice(0, PAGE_CAP)} [page continues; cut here]` : body };
}

const CheckSchema = z.object({
  summary: z.string().describe("Two plain sentences for the editor: what this page is about, and whether its entries hang together as one story (name any weak spots even if not worth a flag)."),
  page_issue: z.string().nullable().describe("A problem with the page as a whole (e.g. it lumps unrelated subjects together), or null."),
  flags: z.array(z.object({
    key: z.string().nullable().describe("The entry's key exactly as given, or null for a problem outside the entries."),
    problem: z.enum(CHECK_PROBLEMS as [FlagProblem, ...FlagProblem[]]),
    reason: z.string().describe("One plain sentence a resident would understand."),
  })),
});

type Example = { problem: FlagProblem; reason: string; entry_text: string; verdict: FlagVerdict; note?: string | null };
type Rule = { problem: string; text: string };

export function checkPrompt(page: ReadPage, examples: Example[], rules: Rule[] = []) {
  // Approved guidance replaces the built-in description of its problem type.
  const ruleFor = new Map(rules.map((r) => [r.problem, r.text]));
  const problems = CHECK_PROBLEMS.map((k) => `- ${k}: ${ruleFor.get(k) ?? FLAG_PROBLEMS[k]}`).join("\n");
  const content = page.entries.length
    ? page.entries.map(e => `[${e.key}] ${e.text}`).join("\n\n")
    : page.body;
  const calibration = examples.length
    ? `\n\nAn editor rated flags on pages like this one. Flag what they agreed with; don't flag the kind of thing they rejected.\n` +
      examples.map(e => `- ${e.verdict === "agree" ? "AGREED" : "REJECTED"} ${e.problem}: ${e.reason} (entry: "${e.entry_text.slice(0, 220)}")${e.note ? ` Editor: ${e.note}` : ""}`).join("\n")
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
  const kind = reviewKind(path);
  const [examples, guidance] = await Promise.all([
    examplesFor(supabase, kind, [page.heading, page.description, ...page.entries.map((e) => e.text), page.body].join("\n").slice(0, 6000)),
    approvedGuidance(supabase, kind),
  ]);
  const result = await getAiClient().json({
    stage: "review",  // REVIEW_AI_MODEL, else the site's AI_MODEL
    prompt: checkPrompt(page, examples, guidance.rules),
    schema: CheckSchema,
    schemaName: "page_check",
  });
  const byKey = new Map(page.entries.map(e => [e.key, e.text]));
  // What staff already decided on this page: a re-raised flag (same entry, same problem) keeps its rating;
  // rated flags the new check drops are kept as history, still teaching later checks.
  const { data: prior } = await supabase.from("page_reviews").select("ai_flags, ai_rated_history").eq("path", path).maybeSingle();
  const priorFlags = ((prior?.ai_flags || []) as PageFlag[]);
  const decidedFlag = (f: PageFlag) => f.verdict !== null || !!f.note;
  const same = (a: PageFlag, b: { key: string | null; problem: string }) => a.key === b.key && a.problem === b.problem;
  const flags: PageFlag[] = [
    ...result.data.flags
      .filter(f => f.key === null || byKey.has(f.key))
      .map(f => {
        const before = priorFlags.find(p => decidedFlag(p) && same(p, f));
        return { key: f.key, problem: f.problem, reason: f.reason, excerpt: (f.key && byKey.get(f.key)) || page.heading,
          verdict: before?.verdict ?? null, ...(before?.note ? { note: before.note } : {}), ...(before?.fixed ? { fixed: true } : {}) };
      }),
    // Staff's own issues aren't the check's to drop.
    ...priorFlags.filter(p => p.problem === "editor_issue" && !p.fixed),
  ];
  const dropped = priorFlags.filter(p => decidedFlag(p) && p.problem !== "editor_issue" && !flags.some(f => same(f, p)));
  const history = [...((prior?.ai_rated_history || []) as PageFlag[]), ...dropped].slice(-50);
  const checked_at = new Date().toISOString();
  const { error } = await supabase.from("page_reviews").upsert({
    path, kind: reviewKind(path), title: page.heading || page.title || null,
    ai_flags: flags, ai_rated_history: history, ai_page_issue: result.data.page_issue, ai_summary: result.data.summary,
    ai_guidance_version: guidance.version,
    ai_entries: page.entries.length, ai_model: result.model, ai_checked_at: checked_at,
  }, { onConflict: "path" });
  if (error) throw new Error("Could not save the page check.");
  return { path, flags, page_issue: result.data.page_issue, summary: result.data.summary, model: result.model, checked_at, entries: page.entries.length };
}

/** An admin's verdict on one flag (by its position in the stored list); null clears it. */
export async function rateFlag(supabase: SupabaseClient, path: string, index: number, verdict: FlagVerdict | null, userId?: string) {
  const { data, error } = await supabase.from("page_reviews").select("ai_flags, ai_model, ai_guidance_version").eq("path", path).maybeSingle();
  if (error || !data?.ai_flags || !Array.isArray(data.ai_flags) || !data.ai_flags[index]) throw new Error("No such flag.");
  const flags = [...(data.ai_flags as PageFlag[])];
  flags[index] = { ...flags[index], verdict };
  const saved = await supabase.from("page_reviews").update({ ai_flags: flags }).eq("path", path);
  if (saved.error) throw new Error("Could not save the rating.");
  await remember(supabase, path, [flags[index]], data, userId);
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
export async function resolveFlags(supabase: SupabaseClient, path: string, match: { key?: string; index?: number }, userId?: string) {
  const { data } = await supabase.from("page_reviews").select("ai_flags, ai_model, ai_guidance_version").eq("path", path).maybeSingle();
  const flags = (data?.ai_flags || []) as PageFlag[];
  const hit = (f: PageFlag, i: number) => (match.index !== undefined ? i === match.index : !!match.key && f.key === match.key);
  if (!flags.some(hit)) return;
  const updated = flags.map((f, i) => (hit(f, i) ? { ...f, verdict: "agree" as const, fixed: true } : f));
  const saved = await supabase.from("page_reviews").update({ ai_flags: updated }).eq("path", path);
  if (saved.error) throw new Error("Could not save the flag.");
  await remember(supabase, path, updated.filter(hit), data, userId);
}

/** Staff's instruction for the fix agent on one flag. Writing one agrees the flag is a problem. */
export async function setFlagNote(supabase: SupabaseClient, path: string, index: number, note: string, userId?: string) {
  const { data } = await supabase.from("page_reviews").select("ai_flags, ai_model, ai_guidance_version").eq("path", path).maybeSingle();
  const flags = [...((data?.ai_flags || []) as PageFlag[])];
  if (!flags[index]) throw new Error("No such flag.");
  const text = note.trim().slice(0, 1000) || null;
  flags[index] = { ...flags[index], note: text, ...(text ? { verdict: "agree" as const } : {}),
    // A staff issue is its own text: editing it rewrites the issue.
    ...(flags[index].problem === "editor_issue" && text ? { reason: text } : {}) };
  const saved = await supabase.from("page_reviews").update({ ai_flags: flags }).eq("path", path);
  if (saved.error) throw new Error("Could not save the instruction.");
  await remember(supabase, path, [flags[index]], data, userId);
}

/** Every staff decision on a check's flag becomes (or updates) a permanent example the check learns from. */
async function remember(supabase: SupabaseClient, path: string, flags: PageFlag[], row: any, userId?: string) {
  for (const flag of flags) {
    await recordExample(supabase, { path, kind: reviewKind(path), flag, userId, model: row?.ai_model, guidanceVersion: row?.ai_guidance_version });
  }
}

/** Staff's own issue for the fix agent ("say whether the 2023 agreement renews the 2021 one"), as an agreed flag. */
export async function addEditorIssue(supabase: SupabaseClient, path: string, text: string, heading: string | null) {
  const issue = text.trim().slice(0, 1000);
  if (!issue) throw new Error("Could not save an empty issue.");
  const { data } = await supabase.from("page_reviews").select("ai_flags").eq("path", path).maybeSingle();
  const flags = [...((data?.ai_flags || []) as PageFlag[]), {
    key: null, problem: "editor_issue" as const, reason: issue, excerpt: heading || "Whole page", verdict: "agree" as const, note: issue,
  }];
  const { error } = data
    ? await supabase.from("page_reviews").update({ ai_flags: flags }).eq("path", path)
    : await supabase.from("page_reviews").insert({ path, kind: reviewKind(path), title: heading, ai_flags: flags });
  if (error) throw new Error("Could not save the issue.");
}
