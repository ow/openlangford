import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { getAiClient } from "./ai/index.server";
import { renderPage } from "../lib/page-render.server";
import { reviewKind } from "./page-reviews.server";
import type { FlagProblem, FlagVerdict, PageFlag } from "../lib/page-review-types";
import { approvedGuidance, examplesFor, recordExample } from "./review-learning.server";
import { itemRecords, topicItemIds, verifyAgainstRecords } from "./page-verify.server";
import { listSuggestions, matterForPath, type Suggestion } from "./page-links.server";
import { sameSiteTopics } from "./properties";

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
  unsupported: "A statement the council's records don't back or contradict (found by checking against the records, not by reading).",
  editor_issue: "Something an editor wants changed (added by staff, never by the check).",
  page_issue: "A problem with the page as a whole (from the check's page_issue, stored as a flag so it's rated and fixed like the rest).",
};
/** What the check itself may flag: everything except staff's own issues. */
const CHECK_PROBLEMS = (Object.keys(FLAG_PROBLEMS) as FlagProblem[]).filter((p) => p !== "editor_issue" && p !== "unsupported" && p !== "page_issue");
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

/** What a reader sees: the title, heading, description, and each timeline entry (by its anchor key). A page larger
 * than PAGE_CAP characters (far beyond any real one) fails openly rather than being cut. */
const PAGE_CAP = 800_000;

export function readPage(html: string): ReadPage {
  const title = plain(html.match(/<title>([\s\S]*?)<\/title>/i)?.[1] || "");
  const heading = plain(html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1] || "");
  const description = plain(html.match(/<meta\s+name="description"\s+content="([^"]*)"/i)?.[1] || "");
  // Entries a page marks for review: topic timelines (<li id="timeline-…">) and any element with
  // data-review-entry="…" (a meeting's agenda items, with their motions and votes).
  const starts = [...html.matchAll(/<li\b[^>]*\bid="timeline-([^"]+)"[^>]*>|<[a-z]+\b[^>]*\bdata-review-entry="([^"]+)"[^>]*>/g)]
    .map((m) => Object.assign(m, { 1: m[1] ?? m[2] }));
  const mainEnd = html.lastIndexOf("</main>");
  const entries = starts.map((m, i) => {
    const from = m.index! + m[0].length;
    // The last entry ends where its list ends, or at the end of the page's main content, never in the footer.
    const ends = [html.indexOf("</ol>", from), mainEnd].filter((n) => n > from);
    let next = starts[i + 1]?.index ?? (ends.length ? Math.min(...ends) : undefined);
    // A Related topics card is one flat list item: it ends with its own </li>, before the timeline that follows.
    const close = m[1].startsWith("related-") ? html.indexOf("</li>", from) : -1;
    if (close > from && (next === undefined || close < next)) next = close;
    return { key: m[1], text: plain(html.slice(from, next)) };
  }).filter(e => e.text);
  const mainStart = html.search(/<main\b/i);
  const main = html.match(/<main\b[^>]*>([\s\S]*)<\/main>/i)?.[1] || html;
  // Whole pages: a long meeting's motions and votes are at the bottom. The cap only guards against a runaway
  // page (about 200,000 tokens), far beyond any real one. A page with entries still sends what comes before
  // them (a meeting's summary and who attended), which the entries are judged against.
  const body = entries.length ? plain(html.slice(mainStart >= 0 ? mainStart : 0, starts[0].index)) : plain(main);
  // Never cut: a page too large for the review model fails openly instead.
  if (body.length + entries.reduce((n, e) => n + e.text.length, 0) > PAGE_CAP) throw new Error("This page is too large for the review model to read at once.");
  return { title, heading, description, entries, body };
}

const CheckSchema = z.object({
  summary: z.string().describe("Two plain sentences for the editor: what this page is about, and whether its entries hang together as one story (name any weak spots even if not worth a flag)."),
  page_issue: z.string().nullable().describe("A problem with the page as a whole that no flag covers (e.g. it lumps unrelated subjects together), or null. Never restate a flag."),
  flags: z.array(z.object({
    key: z.string().nullable().describe("The entry's key exactly as given, or null for a problem outside the entries."),
    problem: z.enum(CHECK_PROBLEMS as [FlagProblem, ...FlagProblem[]]),
    reason: z.string().describe("One plain sentence a resident would understand."),
    fix: z.string().describe("What should change, as one instruction an editor can approve: e.g. \"Remove this entry from the page\", \"Move this item to the 2022 budget topic\", \"Rewrite the status to say Council rescinded the direction on Nov 4, 2024\", \"Merge with the Shared micromobility parking and licence topic\"."),
  })),
});

/** Two readings of one page as one: the first reading's summary, every distinct flag (one per entry and problem), and
 * the first page-wide issue either raised. */
/** Flags staff agreed with that aren't fixed and that a new check didn't raise again. While the entry reads as it did
 * when staff agreed, the flag stays open on the page. When the entry's text has changed since (a hand edit, a fix to
 * the page itself) and the check no longer finds the problem, the flag is resolved: fixed, with a re-check line saying
 * so (2026-11-08: six flags on a meeting page outlived the template bug they described). `entryText` gives an entry's
 * text as the page shows it now; a page-level flag has no entry and stays open. */
export function agreedStillOpen(prior: PageFlag[], fresh: PageFlag[], entryText: (key: string) => string | undefined = () => undefined): PageFlag[] {
  const same = (a: PageFlag, b: PageFlag) => a.key === b.key && a.problem === b.problem && a.excerpt === b.excerpt;
  return prior.filter((p) => p.verdict === "agree" && !p.fixed && p.problem !== "editor_issue" && !fresh.some((f) => same(f, p)))
    .map((p) => {
      const now = p.key ? entryText(p.key) : undefined;
      if (!p.key || now === undefined || now === p.excerpt) return p;
      return { ...p, fixed: true, recheck: { holds: true, checked: false, at: new Date().toISOString(),
        reason: "The entry changed since staff agreed, and the check no longer finds this problem." } };
    });
}

export function combineReadings(readings: z.infer<typeof CheckSchema>[]): z.infer<typeof CheckSchema> {
  const flags: z.infer<typeof CheckSchema>["flags"] = [];
  for (const reading of readings) {
    for (const flag of reading.flags) {
      if (!flags.some((f) => f.key === flag.key && f.problem === flag.problem)) flags.push(flag);
    }
  }
  return { summary: readings[0].summary, page_issue: readings.find((r) => r.page_issue)?.page_issue ?? null, flags };
}

type Example = { problem: FlagProblem; reason: string; entry_text: string; verdict: FlagVerdict; note?: string | null };
type Rule = { problem: string; text: string };

/** What else to look for, by kind of page (the timeline guidance above suits topic pages). */
const KIND_GUIDANCE: Record<string, string> = {
  meetings: `This is one council or committee meeting. Each entry is an agenda item with its summary, motions, outcome and
votes. Check that a summary says what the motions and outcome say; that a vote count, mover and seconder fit the people
the page lists as attending; that an outcome isn't missing where a motion was made; and that speaker names make sense.
Use wrong_detail for a contradiction, unclear_why for an item whose summary doesn't say what happened. A motion's
wording is copied from the City's minutes: a slip in it (a unit conversion, a committee's name) is the City's own
record, which the page rightly shows as written, so don't flag it unless the page's own summary repeats it as fact.`,
  people: `This is a person's page: their roles and terms, votes, attendance and what they said. Check that dates and roles
agree with each other, and that any claim about how they voted or what they said fits what the page lists.`,
  properties: `This is a property's page: the council business about this address. Flag an entry that's about a different
address or only mentions this one in passing. A street's page lists the addresses on it, each linking to its own page
with that address's council business: a street page with only that list is complete, not empty.`,
};

/** A search suggestion's key, as the fix agent knows it ("suggestion-L12" a meeting item or topic, "suggestion-R7" a report page). */
export const suggestionKey = (s: Pick<Suggestion, "table" | "id">) => `suggestion-${s.table === "matter_links" ? "L" : "R"}${s.id}`;

const RelatedSchema = z.object({
  topics: z.array(z.object({
    key: z.string().describe("The related topic's key exactly as given (related-<id>)."),
    verdict: z.enum(["belongs", "same_project", "different"]).describe(
      "belongs: a separate topic about the same place or project, rightly listed. same_project: the very same project or agreement as this page (a renewal, extension or later step of it), so the two should be one topic. different: about another place or project."),
    reason: z.string().describe("One plain sentence a resident would understand, from the records."),
  })),
});

export type TopicVerdict = z.infer<typeof RelatedSchema>["topics"][number];

/** Other topics judged against this one from both topics' records (never their model-written summaries): belongs (a
 * separate topic about the same place or project), same_project (the very same project, so one topic) or different.
 * Each `others` key is "related-<id>". Shared by the page check (the Related topics cards) and the fix agent (a topic
 * holding an entry the agent was asked to file here: merged when it's the same project). Only verdicts for the keys
 * given are returned. */
export async function judgeTopics(supabase: SupabaseClient, matterId: number,
  others: { key: string; text: string; sameSite?: boolean }[],
  options: { shown?: string; signal?: AbortSignal } = {}): Promise<TopicVerdict[]> {
  if (!others.length) return [];
  const own = (await itemRecords(supabase, await topicItemIds(supabase, matterId))).text;
  const theirs = await Promise.all(others.map(async (e) =>
    (await itemRecords(supabase, await topicItemIds(supabase, Number(e.key.slice(8)))).catch(() => ({ text: "" }))).text));
  const result = await getAiClient().json({
    stage: "related_check",
    prompt: `A topic page on Open Langford, a site that follows Langford City council, ${options.shown ?? `lists other topics under "Related
topics: Other topics about the same place or project."`} Decide for each listed topic, from the council's records of both
topics, whether it belongs there. Judge from the records, not the titles. A topic marked as another application for the
same site (an earlier or later rezoning, permit or subdivision of the same land) belongs, though it's a different
application: it's same_project only when the records show the very same application (the same file or bylaw number).

THIS TOPIC'S RECORDS:
${own.slice(0, 20000) || "(none)"}

${others.map((e, i) => `[${e.key}]${e.sameSite ? " [another application for the same site]" : ""} as listed: ${e.text}\nIts records:\n${theirs[i].slice(0, 30000) || "(none)"}`).join("\n\n")}`,
    schema: RelatedSchema,
    schemaName: "related_topics_check",
    signal: options.signal,
  });
  const keys = new Set(others.map((e) => e.key));
  return result.data.topics.filter((t) => keys.has(t.key));
}

/** Topics listed under Related topics, judged from the records of both topics (not their model-written summaries):
 * flags one about a different place or project, or one that is this same project and should be merged. */
export async function checkRelatedTopics(supabase: SupabaseClient, matterId: number, entries: PageEntry[], sameSiteIds: Set<number> = new Set()): Promise<PageFlag[]> {
  const related = entries.filter((e) => /^related-\d+$/.test(e.key)).slice(0, 8);
  if (!related.length) return [];
  const verdicts = await judgeTopics(supabase, matterId, related.map((e) => ({ ...e, sameSite: sameSiteIds.has(Number(e.key.slice(8))) })));
  const byKey = new Map(related.map((e) => [e.key, e.text]));
  return verdicts.filter((t) => t.verdict !== "belongs").map((t) => ({
    key: t.key,
    problem: t.verdict === "different" ? "different_story" as const : "duplicate" as const,
    reason: t.reason,
    fix: t.verdict === "different" ? "Take this topic off Related topics" : "Merge this topic with the page's topic",
    excerpt: byKey.get(t.key)!,
    verdict: null,
  }));
}

export function checkPrompt(page: ReadPage, examples: Example[], rules: Rule[] = [], kind = "matters", suggestions: Suggestion[] = [], sameSite: string[] = []) {
  // Approved guidance replaces the built-in description of its problem type.
  const ruleFor = new Map(rules.map((r) => [r.problem, r.text]));
  const problems = CHECK_PROBLEMS.map((k) => `- ${k}: ${ruleFor.get(k) ?? FLAG_PROBLEMS[k]}`).join("\n");
  const content = page.entries.length
    ? `${page.body ? `Before the entries:\n${page.body}\n\n` : ""}${page.entries.map(e => `[${e.key}] ${e.text}`).join("\n\n")}`
    : page.body;
  const calibration = examples.length
    ? `\n\nAn editor rated flags on pages like this one. Flag what they agreed with; don't flag the kind of thing they rejected.\n` +
      examples.map(e => `- ${e.verdict === "agree" ? "AGREED" : "REJECTED"} ${e.problem}: ${e.reason} (entry: "${e.entry_text}")${e.note ? ` Editor: ${e.note}` : ""}`).join("\n")
    : "";
  return `You're a Langford resident reading this page on Open Langford, a site that follows City council. Point out what
would confuse or mislead you. Only flag clear problems a careful reader would notice; most entries are fine,
and a page with nothing wrong gets no flags. Raise each problem once, on the entry it's about. A timeline entry may be a small mention of this subject inside a
meeting about something else; that's fine if the entry shows why it's there.${sameSite.length ? `

The same land had other applications, shown on the page under "Also at": ${sameSite.map((t) => `"${t}"`).join(", ")}.
Entries marked "Part of" one of them are there on purpose, as this land's history: don't flag them as different_story or
duplicate for being a different application, only when the entry itself is about other land.` : ""}

Problems:
${problems}${KIND_GUIDANCE[kind] ? `\n\n${KIND_GUIDANCE[kind]}` : ""}${calibration}

Page: ${page.title}
Heading: ${page.heading}
Description: ${page.description}

${page.entries.length ? (kind === "meetings" ? "The page, then its agenda items, each with its key:" : "Timeline entries (newest first), each with its key:") : "Page text:"}
${content}${suggestions.length ? `

A search of the council's records found these entries, NOT yet on the page (an editor decides whether to add them):
${suggestions.map((x) => `[${suggestionKey(x)}] ${x.date ? `${String(x.date).slice(0, 10)} ` : ""}${x.title}${x.quote ? `: "${x.quote}"` : ""}${x.reason ? ` (found because: ${x.reason})` : ""}`).join("\n")}
When the page lacks a step or fact one of these supplies (its adoption, the decision its status says is missing), don't
just say it's missing: say which one supplies it in the fix, e.g. "Add the suggested entry ${suggestionKey(suggestions[0])}".` : ""}`;
}

/** A topic's suggestions waiting for a decision, for the check to point a missing step at. The check doesn't wait for a
 * "find missing" search it started (about 30s): the review bar shows what that search finds when it's done. */
async function pendingSuggestions(supabase: SupabaseClient, matterId: number | null): Promise<Suggestion[]> {
  return matterId ? listSuggestions(supabase, matterId).catch(() => []) : [];
}

/** Check one page and store the result on its page_reviews row (keeping any review status and note). */
/** The check itself, without saving: what `checkPage` would store. The gold-set runner (scripts/gold-checks.ts)
 * scores it against staff's ratings without touching the page's review. */
export async function runCheck(supabase: SupabaseClient, origin: string, path: string): Promise<{
  page: ReadPage; flags: PageFlag[]; history: PageFlag[]; summary: string; page_issue: string | null; model: string; guidanceVersion: number | null;
}> {
  const page = readPage(await renderPage(origin, path));
  const kind = reviewKind(path);
  // Two readings at once: against the records behind the page (page-verify), and as a resident (this prompt), which
  // can point a missing step at a suggestion already found.
  const matterId = kind === "matters" ? await matterForPath(supabase, path) : null;
  // Earlier and later applications for the same land: context the page shows on purpose, not stray entries.
  const sameSite = matterId ? await sameSiteTopics(supabase, matterId).catch(() => []) : [];
  const relatedMatterId = page.entries.some((e) => e.key.startsWith("related-")) ? matterId : null;
  const relating = relatedMatterId ? checkRelatedTopics(supabase, relatedMatterId, page.entries, new Set(sameSite.map((m) => m.id))).catch((error) => {
    console.error("[page-check] checking related topics failed:", error instanceof Error ? error.message : error);
    return [] as PageFlag[];
  }) : Promise.resolve([] as PageFlag[]);
  // Related topics are judged from their records by checkRelatedTopics, not by the reader's check.
  const reading = { ...page, entries: page.entries.filter((e) => !e.key.startsWith("related-")) };
  const verifying = verifyAgainstRecords(supabase, path).catch((error) => {
    console.error("[page-check] verifying against the records failed:", error instanceof Error ? error.message : error);
    return [] as PageFlag[];
  });
  const [examples, guidance, suggestions] = await Promise.all([
    examplesFor(supabase, kind, [page.heading, page.description, ...page.entries.map((e) => e.text), page.body].join("\n").slice(0, 6000)),
    approvedGuidance(supabase, kind),
    kind === "matters" ? pendingSuggestions(supabase, matterId) : Promise.resolve([] as Suggestion[]),
  ]);
  const prompt = checkPrompt(reading, examples, guidance.rules, kind, suggestions, sameSite.map((m) => m.title));
  // Two readings, flags combined: one reading missed a real problem about one time in three (2026-11-07), because
  // borderline problems come and go between runs. A reading that fails doesn't sink the check while the other stands.
  const read = () => getAiClient().json({
    stage: "review",  // REVIEW_AI_MODEL, else the site's AI_MODEL
    prompt,
    schema: CheckSchema,
    schemaName: "page_check",
  });
  const [readings, unsupported, relatedFlags] = await Promise.all([
    Promise.allSettled([read(), read()]),
    verifying,
    relating,
  ]);
  const done = readings.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
  if (!done.length) throw (readings[0] as PromiseRejectedResult).reason;
  const result = { ...done[0], data: combineReadings(done.map((r) => r.data)) };
  const byKey = new Map(page.entries.map(e => [e.key, e.text]));
  // What staff already decided on this page: a re-raised flag (same entry, same problem) keeps its rating;
  // rated flags the new check drops are kept as history, still teaching later checks.
  const { data: prior } = await supabase.from("page_reviews").select("ai_flags, ai_rated_history").eq("path", path).maybeSingle();
  const priorFlags = ((prior?.ai_flags || []) as PageFlag[]);
  const decidedFlag = (f: PageFlag) => f.verdict !== null || !!f.note;
  // The same flag: same entry, same problem, and the entry reading as it did. An entry that changed since staff rated
  // a flag on it may have a new problem of the same kind: that is a new flag, not one they agreed with (2026-11-08: a
  // "wrong detail" about a label inherited its 👍 onto a "wrong detail" about a video time after the label was fixed).
  const same = (a: PageFlag, b: { key: string | null; problem: string; excerpt?: string }) =>
    a.key === b.key && a.problem === b.problem && a.excerpt === b.excerpt;
  const flags: PageFlag[] = [
    ...result.data.flags
      .filter(f => f.key === null || byKey.has(f.key))
      .map(f => {
        const before = priorFlags.find(p => decidedFlag(p) && same(p, f));
        return { key: f.key, problem: f.problem, reason: f.reason, fix: f.fix, excerpt: (f.key && byKey.get(f.key)) || page.heading,
          verdict: before?.verdict ?? null, ...(before?.note ? { note: before.note } : {}), ...(before?.fixed ? { fixed: true } : {}) };
      }),
    ...unsupported.filter(f => !result.data.flags.some(c => c.key === f.key && (f.key !== null || c.problem === "wrong_detail"))).map(f => {
      const before = priorFlags.find(p => decidedFlag(p) && same(p, f));
      return { ...f, verdict: before?.verdict ?? null, ...(before?.note ? { note: before.note } : {}), ...(before?.fixed ? { fixed: true } : {}) };
    }),
    ...relatedFlags.map(f => {
      const before = priorFlags.find(p => decidedFlag(p) && same(p, f));
      return { ...f, verdict: before?.verdict ?? null, ...(before?.note ? { note: before.note } : {}), ...(before?.fixed ? { fixed: true } : {}) };
    }),
    // The page as a whole: a flag like the rest (rated, sent to the agent, resolved), keeping an earlier rating.
    ...(result.data.page_issue ? [(() => {
      const f = { key: null, problem: "page_issue" as const, reason: result.data.page_issue!, excerpt: page.heading };
      const before = priorFlags.find(p => decidedFlag(p) && p.problem === "page_issue");
      return { ...f, fix: result.data.page_issue, verdict: before?.verdict ?? null, ...(before?.note ? { note: before.note } : {}), ...(before?.fixed ? { fixed: true } : {}) };
    })()] : []),
    // Staff's own issues aren't the check's to drop.
    ...priorFlags.filter(p => p.problem === "editor_issue" && !p.fixed),
  ];
  // Nor is a problem staff agreed with that isn't fixed yet (often one the fix agent's own re-check reopened): a check
  // that happens not to raise it again doesn't make it go away, and dropping it left the page "needs work" with
  // nothing for the agent to fix (2026-11-07, the Walfred Road page).
  flags.push(...agreedStillOpen(priorFlags, flags, (key) => byKey.get(key)));
  const dropped = priorFlags.filter(p => decidedFlag(p) && p.problem !== "editor_issue" && !flags.some(f => same(f, p)));
  const history = [...((prior?.ai_rated_history || []) as PageFlag[]), ...dropped].slice(-50);
  return { page, flags, history, summary: result.data.summary, page_issue: result.data.page_issue, model: result.model, guidanceVersion: guidance.version };
}

export async function checkPage(supabase: SupabaseClient, origin: string, path: string): Promise<PageCheck> {
  const { page, flags, history, summary, page_issue, model, guidanceVersion } = await runCheck(supabase, origin, path);
  const checked_at = new Date().toISOString();
  const { error } = await supabase.from("page_reviews").upsert({
    path, kind: reviewKind(path), title: page.heading || page.title || null,
    ai_flags: flags, ai_rated_history: history, ai_page_issue: null, ai_summary: summary,
    ai_guidance_version: guidanceVersion,
    ai_entries: page.entries.length, ai_model: model, ai_checked_at: checked_at,
  }, { onConflict: "path" });
  if (error) throw new Error("Could not save the page check.");
  return { path, flags, page_issue, summary, model, checked_at, entries: page.entries.length };
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

/** One verdict for every flag still undecided (not rated, not fixed, not an editor's own issue), saved in one write.
 * "Yes to all" used to send one rating per flag, and Fix could start between them. */
export async function rateAllFlags(supabase: SupabaseClient, path: string, verdict: FlagVerdict, userId?: string) {
  const { data, error } = await supabase.from("page_reviews").select("ai_flags, ai_model, ai_guidance_version").eq("path", path).maybeSingle();
  if (error || !Array.isArray(data?.ai_flags)) throw new Error("No such flag.");
  const before = data.ai_flags as PageFlag[];
  const flags = before.map((f) => (f.verdict === null && !f.fixed && f.problem !== "editor_issue" ? { ...f, verdict } : f));
  const rated = flags.filter((f, i) => f !== before[i]);
  if (!rated.length) return flags;
  const saved = await supabase.from("page_reviews").update({ ai_flags: flags }).eq("path", path);
  if (saved.error) throw new Error("Could not save the rating.");
  await remember(supabase, path, rated, data, userId);
  return flags;
}

/** A random public matter page nobody has reviewed or checked yet. */
export async function randomUncheckedMatterPath(supabase: SupabaseClient): Promise<string | null> {
  const visible = () => supabase.from("matters").select("slug", { count: "exact" })
    .not("slug", "is", null).is("merged_into", null).or("meta->>hidden.is.null,meta->>hidden.neq.container");
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
