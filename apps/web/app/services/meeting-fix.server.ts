import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { getAiClient } from "./ai/index.server";
import { FLAG_PROBLEM_LABELS, entryLabel, keepStaffRatings, type PageFlag } from "../lib/page-review-types";
import { itemRecords, recheckClaims, type Claim } from "./page-verify.server";
import { findingText, investigate, investigatedRecords, investigationLine, needsInvestigation } from "./fix-investigation.server";
import { applyRecheck, recheckSummary, flagLabel } from "../lib/page-recheck";
import { logStaffAction } from "./staff.server";
import { highlightPoints } from "../lib/meeting-summary";
import { capital, normal, quoteInRecords, squash } from "./fix-ops.server";
import type { StaffRole } from "../lib/auth.server";

/**
 * The fix agent on a meeting page (/meetings/<slug>). A meeting page's own text is the meeting's highlights
 * (meetings.meta.highlights: bullets with item links, and the description search results show) and each agenda
 * item's summary (agenda_items.plain_english_summary); everything else on the page (titles, motions, votes, who
 * attended) is the record itself, which the agent never edits. So its menu is small: rewrite an item's summary,
 * rewrite or drop a highlight, rewrite the description, or say the page is right or that a person is needed.
 *
 * Text it writes is marked as a person's (meta.manual, the convention topic pages use: see
 * pipeline/ingestion/manual_edits.py), so a re-ingest or a highlights run keeps it and stores its own as `auto`.
 * Every rewrite rests on a record quote that must be in the records read for the page, and is re-checked against
 * them before the page is called fixed. Same flow as page-fix.server.ts: investigate, plan, act, re-check.
 */

export const MEETING_FIX_BUDGET_MS = 90_000;
/** meetings.meta.highlights.description, as the pipeline caps it (meeting_highlights.DESCRIPTION_MAX). */
const DESCRIPTION_MAX = 155;

const Action = z.object({
  action: z.enum(["rewrite_item_summary", "rewrite_highlight", "remove_highlight", "rewrite_description", "set_item_start", "no_change", "cannot_fix"]),
  key: z.string().nullable().describe("The entry's key (item-<id>) for rewrite_item_summary, or the key of the flag answered; null for a highlight, the description or the whole page."),
  index: z.number().int().nullable().describe("rewrite_highlight and remove_highlight: the highlight's number as listed (0-based). Otherwise null."),
  new_text: z.string().nullable().describe("rewrite_item_summary: the item's new summary, one to three plain sentences, outcome first. rewrite_highlight: the new highlight, one sentence. rewrite_description: the new description, under 150 characters, starting with the date as the old one does. Otherwise null."),
  source: z.string().nullable().describe("Where the action rewrites text: the record's own words that support it, quoted exactly, at most 250 characters. set_item_start: the words spoken at the moment the item begins, copied exactly from one TIMED TRANSCRIPT line (the text after the speaker's name, or a run of it at least 25 characters long). Otherwise null."),
  reason: z.string().describe("One short sentence a resident would understand (under 30 words): what you're doing and why, or why it can't be done."),
});
const PlanSchema = z.object({ actions: z.array(Action) });

type Item = { id: number; item_order: string | null; title: string | null; description: string | null; plain_english_summary: string | null; meta: Record<string, any> | null;
  discussion_start_time: number | null; discussion_end_time: number | null };
type Highlights = { bullets: string[]; links?: unknown[]; description?: string; version?: string; [k: string]: unknown };

const itemOf = (key: string | null | undefined) => Number(key?.match(/^item-(\d+)$/)?.[1] ?? NaN);
export { quoteInRecords };

/** A highlight rewritten: links whose phrase the new text still carries stay, in order; the rest go. Exported for tests. */
export function editHighlight(highlights: Highlights, index: number, text: string): Highlights {
  const bullets = [...highlights.bullets];
  bullets[index] = text;
  const links = Array.isArray(highlights.links) ? [...highlights.links] : [];
  const old = Array.isArray(links[index]) ? (links[index] as any[]) : [];
  // Each link whose phrase the new text still carries, in the new text's reading order (the page reads them so).
  const kept = old.map((link) => ({ link, at: typeof link?.text === "string" ? text.indexOf(link.text) : -1 }))
    .filter((x) => x.at >= 0).sort((a, b) => a.at - b.at);
  let from = 0;
  links[index] = kept.filter((x) => { if (x.at < from) return false; from = x.at + x.link.text.length; return true; }).map((x) => x.link);
  return { ...highlights, bullets, links };
}

/** A highlight dropped, with its links. Exported for tests. */
export function dropHighlight(highlights: Highlights, index: number): Highlights {
  const bullets = highlights.bullets.filter((_, i) => i !== index);
  const links = Array.isArray(highlights.links) ? highlights.links.filter((_, i) => i !== index) : [];
  return { ...highlights, bullets, links };
}

type Segment = { id?: number; start_time: number; speaker_name: string | null; text_content: string | null };
const TRANSCRIPT_CHARS = 60_000;
const clock = (s: number) => { const t = Math.max(0, Math.round(s)); const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), x = t % 60; return `${h}:${String(m).padStart(2, "0")}:${String(x).padStart(2, "0")}`; };

/** The meeting's transcript with times, around the flagged items (their windows and ten minutes either side), one
 * line a segment: "[1:04:36] Keith Yacucha: I'll move that council adopt…". What set_item_start quotes from. */
export function timedTranscript(segments: Segment[], from: number, to: number): string {
  const lines: string[] = [];
  let used = 0;
  for (const seg of segments) {
    if (seg.start_time < from || seg.start_time > to || !seg.text_content) continue;
    const line = `[${clock(seg.start_time)}] ${seg.speaker_name || "Speaker"}: ${squash(seg.text_content)}`;
    if (used + line.length > TRANSCRIPT_CHARS) { lines.push("(the transcript goes on; ask for less)"); break; }
    lines.push(line); used += line.length;
  }
  return lines.length ? `TIMED TRANSCRIPT (speaker names are a machine's guess; the time is when the line starts):\n${lines.join("\n")}` : "";
}

/** The transcript line the agent quoted: its words must be in one segment's text (or the segment's whole text in
 * them), 25 characters or more; among several, the one nearest `near` seconds. Null when none. Exported for tests. */
export function findSegment(segments: Segment[], quote: string | null | undefined, near: number): Segment | null {
  const q = normal(quote || "");
  if (q.length < 25) return null;
  const hits = segments.filter((seg) => { const t = normal(seg.text_content || ""); return t.length >= 25 && (t.includes(q) || q.includes(t)); });
  return hits.sort((a, b) => Math.abs(a.start_time - near) - Math.abs(b.start_time - near))[0] ?? null;
}

/** Moving an item's start to `at`: the item starts there; the item before it in time ends there; and any earlier
 * item whose window starts at or after `at` (the run of items the alignment had placed too late) has its window
 * cleared, start and end, for the pipeline's alignment to fill again from the transcript (it fills only empty
 * times). Null when `at` isn't before the item's own end, or isn't after the meeting's first item. Exported for tests. */
export function moveItemStart(items: { id: number; discussion_start_time: number | null; discussion_end_time: number | null }[], itemId: number, at: number):
  { id: number; discussion_start_time?: number | null; discussion_end_time?: number | null }[] | null {
  const item = items.find((i) => i.id === itemId);
  if (!item) return null;
  if (item.discussion_end_time != null && at >= item.discussion_end_time) return null;
  const timed = items.filter((i) => i.id !== itemId && i.discussion_start_time != null).sort((a, b) => a.discussion_start_time! - b.discussion_start_time!);
  const first = timed[0];
  if (first && first.id !== itemId && at <= first.discussion_start_time!) return null;
  const position = item.discussion_start_time ?? at;
  // Items before this one in time whose windows now sit at or after the new start: placed too late, cleared.
  const tooLate = timed.filter((i) => i.discussion_start_time! < position && i.discussion_start_time! >= at);
  const prev = timed.filter((i) => i.discussion_start_time! < at).at(-1) ?? null;
  const out: { id: number; discussion_start_time?: number | null; discussion_end_time?: number | null }[] = [{ id: itemId, discussion_start_time: at }];
  if (prev) out.push({ id: prev.id, discussion_end_time: at });
  for (const i of tooLate) out.push({ id: i.id, discussion_start_time: null, discussion_end_time: null });
  return out;
}

export function meetingPlanPrompt(meeting: { title: string; meeting_date: string }, items: Item[], highlights: Highlights | null, description: string,
  flags: PageFlag[], note: string | null, records: string, findings: (string | undefined)[], noteFinding: string) {
  const itemLine = (i: Item) => `- [item-${i.id}] ${i.item_order ? `${i.item_order} · ` : ""}${squash(i.title || "")}\n  Summary now: ${squash(i.plain_english_summary || "") || "(none; the page shows the agenda's description instead)"}`;
  return `You fix problems on a meeting page of Open Langford, a site that follows Langford City council. An editor
reviewed the page for the ${meeting.title} of ${meeting.meeting_date} and agreed these problems are real:
${flags.map((f, i) => `- [${f.key ?? "whole page"}] ${FLAG_PROBLEM_LABELS[f.problem]}: ${f.reason}${f.fix ? `\n  Approved fix (do this): ${f.fix}` : ""}${f.note ? `\n  Editor's instruction for this entry (follow it, over the fix above): ${f.note}` : ""}${f.recheck && !f.recheck.holds ? `\n  An earlier fix didn't hold when checked against the records: ${f.recheck.reason ?? ""} Keep the record's own wording for that point.` : ""}${findings[i] ? `\n  What you found in the City's records: ${findings[i]}` : ""}`).join("\n")}
${note ? `\nTheir note: ${note}\n${noteFinding ? `  What you found in the City's records: ${noteFinding}\n` : ""}` : ""}
Before planning you searched and read the City's records for each problem ("What you found" above; the records it
rests on are among the records below). Act on what you found: it is the record's own words, not a guess.

What the page's own text is (everything else on it, titles, motions, votes, attendance, is the record itself and
can't be edited here):
The meeting's highlights, as listed (0-based):
${highlights?.bullets.length ? highlights.bullets.map((b, i) => `  ${i}. ${b}`).join("\n") : "  (none)"}
The page's description (search results and share cards): "${description}"
The agenda items with their summaries:
${items.map(itemLine).join("\n")}

What you can do:
- rewrite_item_summary: a new summary for an item (key item-<id>), one to three plain sentences saying what was
  proposed and what the meeting decided, outcome first, using only facts in the records below. No file numbers,
  bylaw numbers or jargon unless the record gives nothing else. Keep what the current summary gets right.
- rewrite_highlight: a new text for one highlight (index), one sentence, outcome first, as the others read. Keep
  the places and names the old one carries where the record bears them out (they link to the items).
- remove_highlight: drop a highlight (index) the records don't support and that can't be made true by rewording.
- rewrite_description: a new description, under ${DESCRIPTION_MAX} characters, starting with the date the way the
  old one does.
- set_item_start: when an item's "Watch discussion" time is wrong (the item is shown as starting or lasting longer
  than it did; a decision's video link falls inside another item's window): give the item's key and, in "source",
  the words spoken at the moment the item begins, copied exactly from one TIMED TRANSCRIPT line (the chair calling
  the item, or the first words about it). The item then starts at that line's time and the item before it ends
  there. An item shown as lasting too long is fixed by setting the start of the item after it (give that item's
  key). The words may come from the TIMED TRANSCRIPT below or from a transcript passage you read while
  researching: they are looked up in the whole meeting's transcript. Only when the line is clearly that item's start.
- no_change: when the editor asks a question and the answer is that the page is right as it is, or an agreed
  problem turns out not to be one. Say why in "reason", from the records. Give the key of the entry, or null.
- cannot_fix: the problem is in the record itself (a wrong seconder or vote count, a document filed under the wrong
  item, an entry's title), which only a person can correct: say exactly which record and what is wrong.
Every rewrite puts the records' own words it rests on in "source", quoted exactly; no other action needs one. A
rewrite whose quote isn't in the records below is not applied. Work only from the records below and what you found;
when they don't say something, write what they do say and leave out what they don't. One action per problem, in
the order the problems are listed; an action for an entry that isn't flagged is ignored.

THE RECORDS (the meeting's own documents and minutes, by agenda item):
${records}`;
}

/** Runs the agent for one meeting page. Never throws. Same contract as fixPage. */
export async function fixMeetingPage(supabase: SupabaseClient, origin: string, path: string, requester: { id: string; staffRole: StaffRole }): Promise<"nothing_new" | "refiling" | void> {
  const startedAt = Date.now();
  const budget = AbortSignal.timeout(MEETING_FIX_BUDGET_MS);
  const timeLeft = () => MEETING_FIX_BUDGET_MS - (Date.now() - startedAt);
  const withStaffRatings = async (mine: PageFlag[]) => {
    const { data: now } = await supabase.from("page_reviews").select("ai_flags").eq("path", path).maybeSingle();
    return keepStaffRatings(now?.ai_flags as PageFlag[] | null, mine);
  };
  const progress = (text: string) => {
    supabase.from("page_reviews").update({ agent_note: text, agent_at: new Date().toISOString() }).eq("path", path).eq("status", "fixing")
      .then(({ error }) => { if (error) console.error("[meeting-fix] progress:", error.message); });
  };
  const finish = async (status: "fixed" | "needs_work", agent_note: string, flags?: PageFlag[]) => {
    await supabase.from("page_reviews").update({
      status, agent_note, agent_at: new Date().toISOString(), ...(flags ? { ai_flags: await withStaffRatings(flags) } : {}),
    }).eq("path", path);
  };
  const log = (action: string, detail: Record<string, string>) =>
    logStaffAction(supabase, { userId: requester.id, role: requester.staffRole, path, action, detail });
  try {
    const slug = path.match(/^\/meetings\/([^/]+)$/)?.[1];
    const { data: row } = await supabase.from("page_reviews").select("ai_flags, note").eq("path", path).maybeSingle();
    const flags = ((row?.ai_flags || []) as PageFlag[]);
    const agreed = flags.filter((f) => f.verdict === "agree" && !f.fixed);
    const { data: meeting } = slug ? await supabase.from("meetings").select("id, title, meeting_date, summary, meta").eq("slug", slug).maybeSingle() : { data: null };
    if (!meeting) return finish("needs_work", "The agent couldn't find this meeting. This one needs a person.");
    if (!agreed.length && !row?.note) {
      if (flags.some((f) => f.verdict === "agree" && f.fixed)) {
        await supabase.from("page_reviews").update({ status: "fixed" }).eq("path", path);
        return "nothing_new";
      }
      return finish("needs_work", "Nothing to fix: no flags were rated 👍 and there's no note.");
    }
    const toResearch = agreed.filter((f) => !f.research && needsInvestigation(f)).length + (row?.note?.trim() ? 1 : 0);
    progress(toResearch ? `Reading the meeting's records and searching the City's records for ${toResearch === 1 ? "1 problem" : `${toResearch} problems`}…` : "Reading the meeting's records…");
    const { data: itemRows } = await supabase.from("agenda_items").select("id, item_order, title, description, plain_english_summary, meta, discussion_start_time, discussion_end_time")
      .eq("meeting_id", meeting.id).order("id");
    const items = (itemRows || []) as Item[];
    const meta = (meeting.meta || {}) as Record<string, any>;
    const highlights: Highlights | null = Array.isArray(meta.highlights?.bullets) ? (meta.highlights as Highlights) : null;
    const description = typeof highlights?.description === "string" ? highlights.description : "";
    // Records: the flagged items' own; for a page-level problem (a highlight, the description) every item the
    // highlights link to, or all of them when the links don't say.
    const flaggedIds = agreed.map((f) => itemOf(f.key)).filter(Number.isSafeInteger);
    const pageLevel = agreed.some((f) => !f.key) || !!row?.note;
    const linked = (highlightPoints({ meta }) || []).flatMap((p) => p.links.map((l) => l.agenda_item_id));
    const recordIds = [...new Set([...flaggedIds, ...(pageLevel ? (linked.length ? linked : items.map((i) => i.id)) : [])])];
    // The transcript with times around the flagged items, for set_item_start (and for the plan to judge a time).
    // A wrong window is fixed by moving a start: the flagged item's own, or the next item's (its end). So the next
    // item by time is in scope too, and the transcript covers both.
    const byTime = items.filter((i) => i.discussion_start_time != null).sort((a, b) => a.discussion_start_time! - b.discussion_start_time!);
    const nextOf = (id: number) => { const i = byTime.findIndex((x) => x.id === id); return i >= 0 ? byTime[i + 1] ?? null : null; };
    const timeScope = new Set(flaggedIds.flatMap((id) => [id, nextOf(id)?.id].filter((x): x is number => x != null)));
    const flaggedItems = items.filter((i) => timeScope.has(i.id) && i.discussion_start_time != null);
    const [covered, investigations, allSegments] = await Promise.all([
      itemRecords(supabase, recordIds),
      investigate(supabase, { path, topic: `${meeting.title}, ${meeting.meeting_date}`, flags: agreed.map((flag) => ({ flag, index: flags.indexOf(flag) })),
        note: row?.note ?? null, signal: budget }),
      // The whole meeting's transcript: set_item_start looks its quote up here, wherever the plan read it (its
      // own timed block, or a passage the investigation read), so a window that is wrong by half an hour is still
      // fixable (2026-10-05 council: an item linked at 1:00:42 that was discussed at 32:26).
      flaggedItems.length ? supabase.from("transcript_segments").select("id, start_time, speaker_name, text_content").eq("meeting_id", meeting.id)
        .order("start_time").limit(6000).then((r) => (r.data || []) as Segment[]) : Promise.resolve([] as Segment[]),
    ]);
    const segments = allSegments;
    // The timed block the plan sees: the flagged items' windows, the moments the investigation found
    // (transcript:<meeting>:<seconds> refs), and ten minutes either side of each.
    const foundTimes = investigations.flatMap((i) => [...(i.finding?.ref || "").matchAll(/transcript:\d+:([\d.]+)/g)].map((m) => Number(m[1]))).filter(Number.isFinite);
    const spans = [...flaggedItems.map((i) => ({ from: i.discussion_start_time! - 600, to: (i.discussion_end_time ?? i.discussion_start_time! + 1800) + 600 })),
      ...foundTimes.map((t) => ({ from: t - 600, to: t + 600 }))].sort((a, b) => a.from - b.from);
    const merged = spans.reduce<{ from: number; to: number }[]>((out, x) => { const last = out.at(-1); if (last && x.from <= last.to) last.to = Math.max(last.to, x.to); else out.push({ ...x }); return out; }, []);
    const transcript = merged.map((x) => timedTranscript(segments, x.from, x.to)).filter(Boolean).join("\n\n");
    const findingFor = (i: { finding: Parameters<typeof findingText>[0] } | undefined) => findingText(i?.finding);
    const found = investigations.filter((i) => i.finding?.ref && i.finding.verdict !== "not_found");
    const lookedInto = found.length ? `Evidence, from the City's records:\n${found.map((i) =>
      `• ${capital(entryLabel(i.key, flags))}: ${brief(i.finding!.explanation, 220)} (${i.finding!.ref})`).join("\n")}` : "";
    const researchText = [investigations.map(investigationLine).filter(Boolean).join("\n"), await investigatedRecords(supabase, investigations)].filter(Boolean).join("\n\n");
    const records = [covered.text, transcript, researchText].filter(Boolean).join("\n\n");
    if (!records) return finish("needs_work", "The agent found no records for this meeting to work from. This one needs a person.");

    progress("Planning the fix…");
    const result = await getAiClient().json({
      stage: "review",
      prompt: meetingPlanPrompt(meeting, items, highlights, description, agreed, row?.note ?? null, records,
        agreed.map((f) => findingFor(investigations.find((i) => i.index === flags.indexOf(f)))),
        findingFor(investigations.find((i) => i.index === null))),
      schema: PlanSchema, schemaName: "meeting_fix_plan", signal: budget,
    });

    progress(`Making ${result.data.actions.length === 1 ? "1 change" : `${result.data.actions.length} changes`}…`);
    const done: string[] = []; const answered: string[] = []; const left: string[] = [];
    const fixedKeys = new Set<string>(); let pageFixed = false;
    const claims: Claim[] = [];
    const at = new Date().toISOString();
    const agreedKeys = new Set(agreed.map((f) => f.key));
    let newHighlights: Highlights | null = highlights ? { ...highlights, bullets: [...highlights.bullets] } : null;
    let newDescription: string | null = null;
    const quoteOf = (step: { source: string | null }) => squash(step.source || "");
    for (const step of result.data.actions) {
      const key = step.key && agreedKeys.has(step.key) ? step.key : null;
      if (step.action === "no_change") { answered.push(step.reason); if (key) fixedKeys.add(key); else if (agreedKeys.has(null)) pageFixed = true; continue; }
      if (step.action === "cannot_fix") { left.push(step.reason); continue; }
      const text = squash(step.new_text || "");
      if (step.action === "rewrite_item_summary") {
        const id = itemOf(step.key);
        const item = items.find((i) => i.id === id);
        if (!item || !key) { left.push(`${step.reason} (that entry isn't flagged on this page, so nothing changed)`); continue; }
        if (!quoteInRecords(step.source, records)) { left.push(`${step.reason} (its quote isn't the record's exact words, so nothing changed; press Fix again)`); continue; }
        if (text.length < 20 || text.length > 600) { left.push(`${step.reason} (the new summary wasn't usable, so nothing changed)`); continue; }
        const itemMeta = { ...(item.meta || {}) };
        const manual = { ...(itemMeta.manual || {}) };
        manual.summary = { by: requester.id, at, auto: manual.summary?.auto ?? item.plain_english_summary ?? null, source: quoteOf(step).slice(0, 400) };
        const { error } = await supabase.from("agenda_items").update({ plain_english_summary: text, meta: { ...itemMeta, manual } }).eq("id", id);
        if (error) { left.push(`${step.reason} (couldn't save the new summary)`); continue; }
        item.plain_english_summary = text;
        fixedKeys.add(key);
        claims.push({ id: `item-${id}`, key, text: `Summary of item ${id}: ${text}` });
        done.push(`${capital(entryLabel(key, flags))} now reads: "${text}"`);
        await log("agent:rewrite_item_summary", { agenda_item_id: String(id), text: text.slice(0, 400), reason: step.reason.slice(0, 300) });
        continue;
      }
      if (step.action === "set_item_start") {
        const id = itemOf(step.key);
        const item = items.find((i) => i.id === id);
        // The flag this fixes: the item's own, or the flag on the item before it (whose end this start is).
        const prevId = byTime[byTime.findIndex((x) => x.id === id) - 1]?.id;
        const flagKey = step.key && agreedKeys.has(step.key) ? step.key : prevId != null && agreedKeys.has(`item-${prevId}`) ? `item-${prevId}` : null;
        if (!item || !flagKey) { left.push(`${step.reason} (that entry isn't flagged on this page, so nothing changed)`); continue; }
        const near = foundTimes.length ? foundTimes[0] : item.discussion_start_time ?? 0;
        const seg = findSegment(segments, step.source, near);
        if (!seg) { left.push(`${step.reason} (the words given aren't a line of the transcript, so the time stays; press Fix again)`); continue; }
        const moves = moveItemStart(items, id, seg.start_time);
        if (!moves) { left.push(`${step.reason} (starting at ${clock(seg.start_time)} isn't before the item's end or after the meeting's start, so the time stays)`); continue; }
        let failed = false;
        for (const move of moves) {
          const row = items.find((i) => i.id === move.id)!;
          const rowMeta = { ...(row.meta || {}) };
          const manual = { ...(rowMeta.manual || {}) };
          for (const col of ["discussion_start_time", "discussion_end_time"] as const) {
            if (move[col] === undefined) continue;
            // A cleared window isn't a person's value: the alignment stage may fill it, so no manual lock for it.
            if (move[col] === null) { delete manual[col]; continue; }
            manual[col] = { by: requester.id, at, auto: manual[col]?.auto ?? row[col] ?? null, source: squash(step.source || "").slice(0, 300) };
          }
          const { error } = await supabase.from("agenda_items").update({ ...("discussion_start_time" in move ? { discussion_start_time: move.discussion_start_time } : {}),
            ...("discussion_end_time" in move ? { discussion_end_time: move.discussion_end_time } : {}), meta: { ...rowMeta, manual } }).eq("id", move.id);
          if (error) { failed = true; break; }
          if (move.discussion_start_time !== undefined) row.discussion_start_time = move.discussion_start_time ?? null;
          if (move.discussion_end_time !== undefined) row.discussion_end_time = move.discussion_end_time ?? null;
        }
        if (failed) { left.push(`${step.reason} (couldn't save the new time)`); continue; }
        fixedKeys.add(flagKey);
        const cleared = moves.filter((m) => m.discussion_start_time === null).length;
        claims.push({ id: `start-${id}`, key: flagKey, text: `Item ${id}'s discussion starts at ${clock(seg.start_time)}, when this was said: "${squash(seg.text_content || "")}"` });
        done.push(`${flagKey === step.key ? capital(entryLabel(flagKey, flags)) : `The item after ${entryLabel(flagKey, flags)}`} now starts at ${clock(seg.start_time)}${moves.some((m) => m.discussion_end_time != null && m.id !== id) ? ", where the item before it ends" : ""}`
          + `${cleared ? `; the video link${cleared === 1 ? "" : "s"} of ${cleared} earlier item${cleared === 1 ? "" : "s"} placed after that moment ${cleared === 1 ? "was" : "were"} cleared for the pipeline to set again` : ""}: ${brief(step.reason, 160)}`);
        await log("agent:set_item_start", { agenda_item_id: String(id), start: String(seg.start_time), reason: step.reason.slice(0, 300) });
        continue;
      }
      if (step.action === "rewrite_highlight" || step.action === "remove_highlight") {
        if (!newHighlights || step.index == null || step.index < 0 || step.index >= newHighlights.bullets.length) { left.push(`${step.reason} (no such highlight)`); continue; }
        if (!agreedKeys.has(null)) { left.push(`${step.reason} (no page-level problem was flagged, so the highlights stay)`); continue; }
        if (step.action === "remove_highlight") {
          const old = newHighlights.bullets[step.index];
          newHighlights = dropHighlight(newHighlights, step.index);
          done.push(`Dropped the highlight "${old}": ${brief(step.reason, 200)}`);
          pageFixed = true;
          continue;
        }
        if (!quoteInRecords(step.source, records)) { left.push(`${step.reason} (its quote isn't the record's exact words, so the highlight stays; press Fix again)`); continue; }
        if (text.length < 15 || text.length > 240) { left.push(`${step.reason} (the new highlight wasn't usable, so it stays)`); continue; }
        newHighlights = editHighlight(newHighlights, step.index, text);
        claims.push({ id: `highlight-${step.index}`, key: null, text: `Meeting highlight: ${text}` });
        done.push(`Highlight ${step.index + 1} now reads: "${text}"`);
        pageFixed = true;
        continue;
      }
      if (step.action === "rewrite_description") {
        if (!newHighlights) { left.push(`${step.reason} (this meeting has no highlights, so its description can't be set here)`); continue; }
        if (!agreedKeys.has(null)) { left.push(`${step.reason} (no page-level problem was flagged, so the description stays)`); continue; }
        if (!quoteInRecords(step.source, records)) { left.push(`${step.reason} (its quote isn't the record's exact words, so the description stays; press Fix again)`); continue; }
        if (text.length < 20 || text.length > DESCRIPTION_MAX + 20) { left.push(`${step.reason} (the new description wasn't usable, so it stays)`); continue; }
        newDescription = text;
        claims.push({ id: "description", key: null, text: `Page description: ${text}` });
        done.push(`The description now reads: "${text}"`);
        pageFixed = true;
      }
    }
    if (newHighlights && (newDescription !== null || JSON.stringify(newHighlights) !== JSON.stringify(highlights))) {
      const { data: fresh } = await supabase.from("meetings").select("meta").eq("id", meeting.id).single();
      const current = { ...((fresh?.meta || {}) as Record<string, any>) };
      const manual = { ...(current.manual || {}) };
      const stored = newDescription !== null ? { ...newHighlights, description: newDescription } : newHighlights;
      manual.highlights = { by: requester.id, at, auto: manual.highlights?.auto ?? current.highlights ?? null };
      const { error } = await supabase.from("meetings").update({ meta: { ...current, highlights: stored, manual } }).eq("id", meeting.id);
      if (error) { left.push("Couldn't save the highlights."); claims.splice(0, claims.length, ...claims.filter((c) => c.id.startsWith("item-"))); pageFixed = false; }
      else await log("agent:rewrite_highlights", { bullets: stored.bullets.join(" | ").slice(0, 600), description: String(stored.description || "").slice(0, 200) });
    }
    // Flags fixed this run; the re-check reads each rewrite against the records.
    const newlyFixed = flags.map((f, i) => (agreed.includes(f) && ((f.key && fixedKeys.has(f.key)) || (!f.key && pageFixed)) ? i : -1)).filter((i) => i >= 0);
    let updated = flags.map((f, i) => newlyFixed.includes(i) ? { ...f, fixed: true } : f);
    let checkedNote = "";
    let recheckFailed = false;
    if (claims.length && timeLeft() > 10_000) {
      progress("Checking that the fixes hold…");
      try {
        const scopes = new Map<number, string[]>();
        for (const i of newlyFixed) {
          const key = flags[i].key;
          const ids = claims.filter((c) => (key ? c.key === key : !c.key)).map((c) => c.id);
          if (ids.length) scopes.set(i, ids);
        }
        const verdicts = scopes.size ? await recheckClaims(claims, records, budget) : new Map();
        const outcome = applyRecheck(updated, newlyFixed, scopes, verdicts, new Date().toISOString());
        updated = outcome.flags;
        const failures = outcome.failed.map((x) => `${flagLabel(flags[x.index])} on ${flags[x.index].key ?? "the page"}: ${x.reason}`);
        checkedNote = recheckSummary(outcome.held, outcome.total, newlyFixed.filter((i) => scopes.has(i)).length, failures);
        for (const failure of failures) left.push(`The fix doesn't hold: ${failure}`);
        recheckFailed = failures.length > 0;
      } catch (error) {
        console.error("[meeting-fix] re-check failed:", error instanceof Error ? error.message : error);
        checkedNote = "Not re-checked: the check itself failed. Press Check to look again.";
      }
    } else if (newlyFixed.length) {
      checkedNote = "Not re-checked: the fix used up its time. Press Check to look again.";
    }
    const note = [
      done.length ? `Changed:\n${done.map((d) => `• ${d}`).join("\n")}` : answered.length ? "" : result.data.actions.length ? "Changed nothing." : "Changed nothing: the agent didn't say what to do. Try rewording the issue as an instruction.",
      answered.length ? `Left as is:\n${answered.map((d) => `• ${d}`).join("\n")}` : "",
      left.length ? `Needs a person:\n${left.map((d) => `• ${d}`).join("\n")}` : "",
      lookedInto, checkedNote,
    ].filter(Boolean).join("\n\n");
    await finish(!recheckFailed && (done.length || (answered.length && !left.length)) ? "fixed" : "needs_work", note, updated);
  } catch (error) {
    console.error("[meeting-fix]", error instanceof Error ? error.message : error);
    await finish("needs_work", budget.aborted
      ? "The agent ran out of time (about 90 seconds of model work) before it could plan the fix, and changed nothing. Press Fix again, or fix it by hand."
      : `The agent hit an error and changed nothing: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const brief = (text: string, max: number) => {
  const t = squash(text || "");
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("; "));
  return end > max / 2 ? cut.slice(0, end + 1) : `${cut.replace(/\s+\S*$/, "")}…`;
};
