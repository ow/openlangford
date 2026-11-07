import type { SupabaseClient } from "@supabase/supabase-js";
import { glossaryIds, glossaryPromptBlock, type GlossaryRegister } from "./ai/glossary-prompt";
import { z } from "zod";
import shared from "../../../../shared/prompts/topic-summaries.json";
import { getAiClient } from "./ai/index.server";
import { fetchAll } from "./page-verify.server";

/**
 * A topic's summary, "where it stands" line, title and timeline headlines, rewritten from its records straight after a
 * staff fix, so the fix agent finishes in one request instead of handing the rewrite to the pipeline's worker.
 *
 * This is the pipeline's summary writer (apps/pipeline/pipeline/ingestion/matter_summaries.py, which writes every
 * topic during ingest) carried over step for step: the same records, the same prompts and schema (both read
 * shared/prompts/topic-summaries.json), the same check against the records with one rewrite, and the same stamp in
 * meta.summary_version. A change to how summaries are written goes in both, or in the shared file.
 */

const SUMMARY_VERSION: string = shared.version;
/** The same system prompt as the pipeline's matter_summaries.py: the shared text plus the glossary block it names. */
const WRITER_SYSTEM = `${shared.system}\n\n${glossaryPromptBlock(shared.glossary.register as GlossaryRegister, glossaryIds(shared.glossary.groups))}`;
const TOPICS = shared.topics as [string, ...string[]];
const STATUSES = shared.statuses as [string, ...string[]];
const FIELDS = shared.fields;
/** The pipeline's system prompt for calls that don't give one (pipeline/ai/client.py DEFAULT_SYSTEM). */
const DEFAULT_SYSTEM = "You are a careful assistant processing municipal council records.";
/** Characters of input per request (pipeline/ai/budget.py INPUT_BUDGET_CHARS). */
const INPUT_BUDGET_CHARS = 1_000_000;
const BATCH_SIZE = 8;
const SAME_SITE_MAX_LOTS = 4;
const KEY_SECTION = /purpose|executive summary|proposal|comment|recommendation|summary|background|discussion|financial/i;
/** A write's output grows with the topic's timeline (one headline per step, ~12 ms a token), so its per-attempt timeout
 * does too: the stage's 30 s, plus half a second a step, never over 90 s. */
const writeTimeout = (batch: Loaded[]) => Math.min(90_000, 30_000 + 500 * batch.reduce((n, m) => n + m.history.length, 0));
/** Python's \s, which also matches the separator controls \x1c-\x1f and \x85 (they turn up in OCR'd reports). */
const SPACE = /[\s\x1c-\x1f\x85]+/g;

const MatterSummaries = z.object({
  matters: z.array(z.object({
    id: z.number().int(),
    display_title: z.string(),
    summary: z.string(),
    status_line: z.string(),
    timeline: z.array(z.object({
      item: z.number().int().describe(FIELDS.timeline_item),
      headline: z.string().describe(FIELDS.timeline_headline),
    })),
    category: z.enum(TOPICS),
    status: z.enum(STATUSES),
  })),
});
type Written = z.infer<typeof MatterSummaries>["matters"][number];

const SummaryCheck = z.object({
  problems: z.array(z.object({
    matter: z.number().int().describe(FIELDS.problem_matter),
    statement: z.string().describe(FIELDS.problem_statement),
    verdict: z.enum(["contradicted", "not_in_record"]),
    record_says: z.string().describe(FIELDS.problem_record_says),
  })),
});
type Problem = { statement: string; verdict: string; record_says: string };

type Meta = Record<string, any>;
type Update = { plain_english_summary: string; meta: Meta; category?: string; status?: string };
/** A topic's inputs as the writer sees them; the "_" fields stay out of the prompt. */
type Loaded = {
  id: number; title: string; identifier: string | null; history: any[]; mentions: any[];
  same_site?: { title: string; dates: string }[]; editor_notes?: string[]; fix_these?: Problem[];
  _has_mentions: boolean; _owned_item_ids: Set<number>; _meta: Meta;
};

const one = <T>(v: T | T[] | null | undefined): T | undefined => (Array.isArray(v) ? v[0] : v ?? undefined);
/** Python truthiness for the record and notes fields: empty strings and lists are left out. */
const filled = (o: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => (Array.isArray(v) ? v.length > 0 : !!v)));

/** Every row of `build(chunk)` for the ids in chunks of 200 (a long id list overflows a request URL), all pages. */
async function inChunks<T = any>(ids: number[], build: (chunk: number[], from: number, to: number) => PromiseLike<{ data: T[] | null; error: any }>) {
  const rows: T[] = [];
  for (let start = 0; start < ids.length; start += 200) {
    const chunk = ids.slice(start, start + 200);
    rows.push(...await fetchAll<T>((from, to) => build(chunk, from, to)));
  }
  return rows;
}

/** The whole video transcript of each item's discussion (pipeline record_sources.item_transcripts). */
async function itemTranscripts(supabase: SupabaseClient, items: any[]): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  for (const item of items) {
    const start = item.discussion_start_time;
    if (start === null || start === undefined || !item.meeting_id) continue;
    const end = item.discussion_end_time !== null && item.discussion_end_time !== undefined ? Number(item.discussion_end_time) : Number(start) + 1800;
    const segments = await fetchAll((from, to) => supabase.from("transcript_segments").select("start_time, speaker_name, text_content")
      .eq("meeting_id", item.meeting_id).gte("start_time", Number(start)).lt("start_time", end).order("start_time").range(from, to));
    const text = segments.map((s: any) => `${s.speaker_name || "Speaker"}: ${s.text_content || ""}`).join("\n");
    if (text.trim()) out.set(item.id, text);
  }
  return out;
}

/** Other topics for the same land as each topic (pipeline matter_summaries._same_site). */
async function sameSite(supabase: SupabaseClient, matterIds: number[]): Promise<Map<number, { title: string; dates: string }[]>> {
  const out = new Map<number, { title: string; dates: string }[]>();
  const own = await inChunks(matterIds, (ids, from, to) => supabase.from("property_links").select("matter_id, property_id")
    .in("matter_id", ids).eq("hidden", false).order("id").range(from, to));
  const lots = new Map<number, Set<number>>();
  for (const l of own as any[]) lots.set(l.matter_id, (lots.get(l.matter_id) || new Set()).add(l.property_id));
  for (const [m, p] of lots) if (p.size > SAME_SITE_MAX_LOTS) lots.delete(m);
  const propertyIds = [...new Set([...lots.values()].flatMap((p) => [...p]))].sort((a, b) => a - b);
  if (!propertyIds.length) return out;
  // Hidden lots (a resident's home known only from public input) never count.
  const publicIds = new Set((await inChunks(propertyIds, (ids, from, to) => supabase.from("properties").select("id").in("id", ids)
    .eq("hidden", false).neq("civic_number", "").order("id").range(from, to)) as any[]).map((p) => p.id as number));
  const sharing = await inChunks([...publicIds].sort((a, b) => a - b), (ids, from, to) => supabase.from("property_links")
    .select("matter_id, property_id").in("property_id", ids).eq("hidden", false).not("matter_id", "is", null).order("id").range(from, to)) as any[];
  const otherIds = [...new Set(sharing.map((l) => l.matter_id as number))].filter((m) => !lots.has(m)).sort((a, b) => a - b);
  const theirs = otherIds.length ? await inChunks(otherIds, (ids, from, to) => supabase.from("property_links").select("matter_id, property_id")
    .in("matter_id", ids).eq("hidden", false).order("id").range(from, to)) as any[] : [];
  for (const l of theirs) lots.set(l.matter_id, (lots.get(l.matter_id) || new Set()).add(l.property_id));
  const small = new Set([...lots].filter(([, p]) => p.size <= SAME_SITE_MAX_LOTS).map(([m]) => m));
  const candidates = [...new Set(sharing.map((l) => l.matter_id as number))].filter((m) => small.has(m)).sort((a, b) => a - b);
  const rows = new Map((await inChunks(candidates, (ids, from, to) => supabase.from("matters")
    .select("id, title, meta, first_seen, last_seen, merged_into").in("id", ids).order("id").range(from, to)) as any[]).map((m) => [m.id as number, m]));
  for (const mid of matterIds) {
    const mine = new Set([...(lots.get(mid) || [])].filter((p) => publicIds.has(p)));
    if (!mine.size || !small.has(mid)) continue;
    const siblings = [...new Set(sharing.filter((l) => mine.has(l.property_id) && l.matter_id !== mid).map((l) => l.matter_id as number))].sort((a, b) => a - b);
    for (const sid of siblings) {
      const row = rows.get(sid);
      if (!row || row.merged_into || row.meta?.hidden) continue;
      // Python's f-string prints a missing date as "None"; kept so both writers see the same input.
      const list = out.get(mid) || [];
      list.push({ title: row.meta?.display_title || row.title, dates: `${row.first_seen ?? "None"} to ${row.last_seen ?? "None"}` });
      out.set(mid, list);
    }
  }
  return out;
}

/** Each topic's whole history and its accepted mentions, with every record in full (pipeline _load_context). */
export async function loadTopicContext(supabase: SupabaseClient, matterIds: number[]): Promise<Loaded[]> {
  const matters = await inChunks(matterIds, (ids, from, to) => supabase.from("matters")
    .select("id, municipality_id, title, identifier, category, status, meta").in("id", ids).order("id").range(from, to)) as any[];
  const ids = matters.map((m) => m.id as number);
  const items = await inChunks(ids, (chunk, from, to) => supabase.from("agenda_items")
    .select("id, matter_id, meeting_id, title, description, plain_english_summary, debate_summary, discussion_start_time, discussion_end_time, meetings(meeting_date, type)")
    .in("matter_id", chunk).order("id").range(from, to)) as any[];
  const links = await inChunks(ids, (chunk, from, to) => supabase.from("matter_links").select("id, matter_id, agenda_item_id")
    .in("matter_id", chunk).eq("kind", "mention").eq("hidden", false).order("id").range(from, to)) as any[];
  const mentionIds = [...new Set(links.map((l) => l.agenda_item_id as number).filter(Boolean))].sort((a, b) => a - b);
  const mentionItems = mentionIds.length ? await inChunks(mentionIds, (chunk, from, to) => supabase.from("agenda_items")
    .select("id, matter_id, title, plain_english_summary, meetings!inner(meeting_date, municipality_id)").in("id", chunk).order("id").range(from, to)) as any[] : [];
  const matterById = new Map(matters.map((m) => [m.id as number, m]));
  const mentionById = new Map(mentionItems.map((i) => [i.id as number, i]));
  const owned = new Set(items.map((i) => `${i.matter_id}:${i.id}`));
  const mentionsByMatter = new Map<number, any[]>();
  for (const link of links) {
    const item = mentionById.get(link.agenda_item_id);
    const mid = link.matter_id as number;
    if (!item || !matterById.has(mid) || owned.has(`${mid}:${item.id}`)) continue;
    const meeting = one<any>(item.meetings) || {};
    if (meeting.municipality_id !== matterById.get(mid).municipality_id) continue;
    const list = mentionsByMatter.get(mid) || [];
    list.push({ item: item.id, date: meeting.meeting_date ?? null, agenda_item: item.title,
      notes: { summary: item.plain_english_summary || "" }, source: "accepted mention" });
    mentionsByMatter.set(mid, list);
  }
  const itemIds = items.map((i) => i.id as number);
  const [motions, docs, sections] = itemIds.length ? await Promise.all([
    inChunks(itemIds, (chunk, from, to) => supabase.from("motions").select("id, agenda_item_id, plain_english_summary, text_content, result")
      .in("agenda_item_id", chunk).order("id").range(from, to)),
    inChunks(itemIds, (chunk, from, to) => supabase.from("extracted_documents").select("id, agenda_item_id, title, document_type, summary, key_facts")
      .in("agenda_item_id", chunk).order("id").range(from, to)),
    // The substance of a staff report lives in its sections, so its own text goes in as record, key sections first.
    inChunks(itemIds, (chunk, from, to) => supabase.from("document_sections").select("id, agenda_item_id, section_title, section_text, section_order")
      .in("agenda_item_id", chunk).order("agenda_item_id").order("section_order").order("id").range(from, to)),
  ]) as any[][] : [[], [], []];
  const excerpts = new Map<number, string[]>();
  const keyFirst = [...sections].sort((a, b) => Number(!KEY_SECTION.test(a.section_title || "")) - Number(!KEY_SECTION.test(b.section_title || "")));
  for (const sec of keyFirst) {
    const text = String(sec.section_text || "").replace(/[#|*]/g, " ").replace(SPACE, " ").trim();
    if (!text) continue;
    excerpts.set(sec.agenda_item_id, [...(excerpts.get(sec.agenda_item_id) || []), sec.section_title ? `${sec.section_title}: ${text}` : text]);
  }
  // Staff reports first; drawings, schedules and forms add little.
  const rank = (d: any) => (String(d.document_type || "").toLowerCase().includes("report") || String(d.title || "").toLowerCase().includes("report") ? 0 : 1);
  const docsByItem = new Map<number, any[]>();
  for (const d of [...docs].sort((a, b) => rank(a) - rank(b))) docsByItem.set(d.agenda_item_id, [...(docsByItem.get(d.agenda_item_id) || []), d]);
  const motionsByItem = new Map<number, any[]>();
  for (const m of motions) motionsByItem.set(m.agenda_item_id, [...(motionsByItem.get(m.agenda_item_id) || []), m]);
  // The video is the original for what was said: every item discussed on video brings its transcript as record.
  const transcripts = await itemTranscripts(supabase, items.filter((i) => i.discussion_start_time !== null && i.discussion_start_time !== undefined));
  const site = await sameSite(supabase, ids);

  return matters.map((matter) => {
    const history = items.filter((item) => item.matter_id === matter.id).map((item) => {
      const meeting = one<any>(item.meetings) || {};
      const mine = motionsByItem.get(item.id) || [];
      return {
        item: item.id,
        date: meeting.meeting_date ?? null,
        meeting: meeting.type ?? null,
        agenda_item: item.title ?? null,
        // The City's own text (record_sources.RECORD_RULE).
        record: filled({
          motions: mine.map((m) => ({ text: m.text_content || "", result: m.result ?? null })),
          report_text: excerpts.get(item.id) || [],
          video_transcript: transcripts.get(item.id),
        }),
        // What a model wrote about it earlier: for orientation, never the source of a fact.
        notes: filled({
          summary: item.plain_english_summary || "",
          description: item.description || "",
          video_summary: item.debate_summary || "",
          motion_summaries: mine.filter((m) => m.plain_english_summary).map((m) => m.plain_english_summary),
          reports: (docsByItem.get(item.id) || []).map((d) => ({ title: d.title ?? null, summary: d.summary || "", key_facts: d.key_facts || [] })),
        }),
      };
    }).sort((a, b) => String(a.date || "").localeCompare(String(b.date || "")));
    const mentions = (mentionsByMatter.get(matter.id) || []).sort((a, b) => String(a.date || "").localeCompare(String(b.date || "")));
    const notes = ((matter.meta?.editor_notes || []) as unknown[]).filter((n): n is string => typeof n === "string" && !!n.trim());
    return {
      id: matter.id, title: matter.title, identifier: matter.identifier ?? null, history, mentions,
      ...(site.get(matter.id)?.length ? { same_site: site.get(matter.id) } : {}),
      ...(notes.length ? { editor_notes: notes } : {}),
      _has_mentions: mentions.length > 0,
      _owned_item_ids: new Set(history.map((h) => h.item as number)),
      _meta: matter.meta || {},
    };
  });
}

const visibleFields = (m: Loaded) => Object.fromEntries(Object.entries(m).filter(([k]) => !k.startsWith("_")));
const promptFor = (batch: Loaded[]) => shared.prompt_intro + JSON.stringify(batch.map(visibleFields));

async function summarize(batch: Loaded[], signal?: AbortSignal): Promise<Map<number, Written>> {
  const { data } = await getAiClient().json({ stage: "writing", system: WRITER_SYSTEM, prompt: promptFor(batch),
    schema: MatterSummaries, schemaName: "MatterSummaries", timeoutMs: writeTimeout(batch), signal });
  return new Map(data.matters.filter((m) => m.summary.trim()).map((m) => [m.id, m]));
}

/** The updates for a batch: decisions from owned proceedings, descriptions with linked context. */
async function generate(batch: Loaded[], signal?: AbortSignal): Promise<Map<number, Update>> {
  const context = batch.filter((m) => m._has_mentions);
  const [decisions, descriptions] = await Promise.all([
    summarize(batch.map((m) => ({ ...m, mentions: [] })), signal),
    context.length ? summarize(context, signal) : Promise.resolve(new Map<number, Written>()),
  ]);
  const out = new Map<number, Update>();
  for (const matter of batch) {
    const fields = decisions.get(matter.id);
    let descriptive: Pick<Written, "display_title" | "summary" | "category"> | undefined = descriptions.get(matter.id) || fields;
    if (!descriptive) continue;
    const meta: Meta = { ...matter._meta };
    meta.display_title = (descriptive.display_title || "").trim() || null;
    meta.summary_version = SUMMARY_VERSION;
    // Lines staff approved through the page review bar (meta.staff_headlines) outlive every rewrite.
    const staffLines = Object.fromEntries(Object.entries(meta.staff_headlines || {}).filter(([, v]) => typeof v === "string" && v.trim()));
    // A recorded replacement (meta.superseded_by) is a later decision the topic's own history doesn't show.
    const superseded = !!meta.superseded_by;
    if (fields && matter.history.length && !superseded) {
      meta.status_line = (fields.status_line || "").trim() || null;
      meta.timeline_headlines = Object.fromEntries(fields.timeline
        .filter((t) => matter._owned_item_ids.has(t.item) && (t.headline || "").trim())
        .map((t) => [String(t.item), t.headline.trim()]));
    } else if (!matter.history.length && !superseded) {
      // Only mentions: where it last came up, as discussion. Without mentions either, no line at all.
      const line = matter._has_mentions ? (descriptions.get(matter.id)?.status_line || "").trim() : "";
      meta.status_line = line || null;
    }
    if (Object.keys(staffLines).length) meta.timeline_headlines = { ...(meta.timeline_headlines || {}), ...staffLines };
    // Text the fix agent edited directly stands until the topic gains a step of its own.
    const staffText = meta.staff_text && typeof meta.staff_text === "object" && !Array.isArray(meta.staff_text) ? meta.staff_text : null;
    if (staffText && [...matter._owned_item_ids].every((id) => (staffText.items || []).includes(id))) {
      if (staffText.status_line) meta.status_line = staffText.status_line;
      if (staffText.summary) descriptive = { ...descriptive, summary: staffText.summary };
    }
    const update: Update = { plain_english_summary: descriptive.summary.trim(), meta };
    if (TOPICS.includes(descriptive.category)) update.category = descriptive.category;
    if (fields && matter.history.length && !superseded && STATUSES.includes(fields.status)) update.status = fields.status;
    out.set(matter.id, update);
  }
  return out;
}

const CombinedCheck = z.object({
  problems: SummaryCheck.shape.problems,
  notes: z.array(z.object({
    matter: z.number().int().describe(FIELDS.problem_matter),
    n: z.number().int().describe(FIELDS.note_n),
    followed: z.boolean().describe(FIELDS.note_followed),
    missing: z.string().describe(FIELDS.note_missing),
  })),
});
export type Unfollowed = { note: string; matter_id: number; missing: string };
type Verdict = { problems: Map<number, Problem[]>; unfollowed: Unfollowed[]; failed: boolean };

/** The payload the check reads: each topic's inputs and written text, and the editor's instructions to judge. */
export function checkPayload(batch: Loaded[], updates: Map<number, Update>, notes: Map<number, string[]> = new Map()) {
  return batch.filter((m) => updates.has(m.id)).map((m) => {
    const u = updates.get(m.id)!;
    const staff = u.meta.staff_headlines || {};
    const instructions = notes.get(m.id) || [];
    return {
      id: m.id,
      records: Object.fromEntries(Object.entries(m).filter(([k]) => !k.startsWith("_") && k !== "fix_these")),
      text: {
        summary: u.plain_english_summary,
        where_it_stands: u.meta.status_line ?? null,
        // Lines staff approved stand as written, so only the writer's own are checked.
        timeline_headlines: Object.fromEntries(Object.entries(u.meta.timeline_headlines || {}).filter(([k]) => !(k in staff))),
      },
      ...(instructions.length ? { editor_instructions: instructions.map((text, n) => ({ n, text })) } : {}),
    };
  });
}

/** Reads the combined check's answer: the topics' fact problems, and each instruction it says isn't followed. An
 * instruction the check didn't answer counts as not followed (it can't be claimed). */
export function readVerdict(data: z.infer<typeof CombinedCheck>, updates: Map<number, Update>, notes: Map<number, string[]>): Omit<Verdict, "failed"> {
  const problems = new Map<number, Problem[]>();
  for (const { matter, ...problem } of data.problems) {
    if (updates.has(matter)) problems.set(matter, [...(problems.get(matter) || []), problem]);
  }
  const unfollowed: Unfollowed[] = [];
  for (const [matter, list] of notes) {
    list.forEach((note, n) => {
      const answer = data.notes.find((x) => x.matter === matter && x.n === n);
      if (!answer || !answer.followed) unfollowed.push({ note, matter_id: matter, missing: answer?.missing || "" });
    });
  }
  return { problems, unfollowed };
}

/** One structured call judging the written text against the records (facts) and each editor instruction (followed or
 * not). When it can't run, the text stands unchecked and every instruction is reported as not confirmed. */
async function checkAll(batch: Loaded[], updates: Map<number, Update>, notes: Map<number, string[]>, signal?: AbortSignal): Promise<Verdict> {
  const payload = checkPayload(batch, updates, notes);
  const asked = new Map([...notes].filter(([m]) => updates.has(m)));
  if (!payload.length) return { problems: new Map(), unfollowed: [], failed: false };
  try {
    const { data } = await getAiClient().json({ stage: "summary_check", system: DEFAULT_SYSTEM,
      prompt: shared.check_prompt + (asked.size ? shared.check_notes_prompt : "") + JSON.stringify(payload),
      schema: CombinedCheck, schemaName: "SummaryCheck", signal });
    return { ...readVerdict(data, updates, asked), failed: false };
  } catch (error) {  // unchecked rather than unwritten
    console.error("[topic-summaries] check failed:", error instanceof Error ? error.message : error);
    return { problems: new Map(), failed: true,
      unfollowed: [...asked].flatMap(([matter_id, list]) => list.map((note) => ({ note, matter_id, missing: "" }))) };
  }
}

/** An update to a topic's title, summary or status line, with any field staff edited by hand kept as they left it
 * (pipeline manual_edits.keep_text_edits; see services/topic-edit.server.ts). */
export async function keepTextEdits(supabase: SupabaseClient, matterId: number, update: { plain_english_summary?: string | null; meta?: Meta } & Record<string, any>) {
  const { data: row } = await supabase.from("matters").select("plain_english_summary, meta").eq("id", matterId).single();
  const stored: Meta = row?.meta || {};
  const manual: Meta = stored.manual || {};
  if (!["title", "summary", "status_line"].some((f) => f in manual)) return update;
  const out = { ...update };
  const meta: Meta = { ...(out.meta || stored) };
  const kept: Meta = { ...manual };
  for (const [field, key] of [["title", "display_title"], ["status_line", "status_line"]] as const) {
    if (field in kept && key in meta) {
      kept[field] = { ...kept[field], auto: meta[key] ?? null };
      meta[key] = stored[key] ?? null;
    }
  }
  if ("summary" in kept && "plain_english_summary" in out) {
    kept.summary = { ...kept.summary, auto: out.plain_english_summary ?? null };
    out.plain_english_summary = row?.plain_english_summary ?? null;
  }
  meta.manual = kept;
  out.meta = meta;
  return out;
}

export type SummaryReport = {
  /** Topics whose rewritten text was saved. */
  written: number[];
  /** Topics whose text was edited directly after the check found problems. */
  edited: number[];
  /** Instructions the final text still doesn't follow. */
  unfollowed: Unfollowed[];
  /** Fact problems the final text still has, per topic. */
  problems: Map<number, Problem[]>;
};

/** What a direct edit is told to fix: the instructions it wasn't followed on, and each statement the records contradict
 * or don't contain, with what they say. */
export function editInstructions(unfollowed: string[], problems: Problem[]): string[] {
  return [...unfollowed, ...problems.map((p) => p.verdict === "contradicted"
    ? `Correct this, the records contradict it: "${p.statement}".${p.record_says ? ` The record says: “${p.record_says}”` : ""}`
    : `Remove or correct this, the records don't contain it: "${p.statement}".${p.record_says ? ` The record says: “${p.record_says}”` : ""}`)];
}

/**
 * Write the summaries of these topics, check them, and save them. One write (the editor's notes are already in the
 * topic's editor_notes, so the writer follows them), one check judging facts and the `notes` instructions together,
 * and when it finds anything, no second rewrite: the text is edited directly (directEdit) and checked once more. With
 * `dryRun` nothing is saved or edited and each update goes to `onUpdate`.
 */
export async function rewriteSummaries(supabase: SupabaseClient, matterIds: Iterable<number>,
  opts: { notes?: { matter_id: number; note: string }[]; signal?: AbortSignal; dryRun?: boolean; onUpdate?: (matterId: number, update: Update) => void } = {}): Promise<SummaryReport> {
  const ids = [...new Set([...matterIds].map(Number))].sort((a, b) => a - b);
  const report: SummaryReport = { written: [], edited: [], unfollowed: [], problems: new Map() };
  if (!ids.length) return report;
  const loaded = await loadTopicContext(supabase, ids);
  // A topic too large for one request is left as it was, never cut to fit.
  const size = (m: Loaded) => promptFor([m]).length;
  const fits = loaded.filter((m) => size(m) <= INPUT_BUDGET_CHARS);
  for (const m of loaded) if (!fits.includes(m)) console.error(`[topic-summaries] topic ${m.id} is too large for one request; not rewritten`);
  const batches: Loaded[][] = [];
  let used = 0;
  for (const m of fits) {
    const last = batches[batches.length - 1];
    if (!last || used + size(m) > INPUT_BUDGET_CHARS || last.length >= BATCH_SIZE) {
      batches.push([m]);
      used = size(m);
    } else {
      last.push(m);
      used += size(m);
    }
  }
  const notesByMatter = new Map<number, string[]>();
  for (const { matter_id, note } of opts.notes || []) notesByMatter.set(matter_id, [...(notesByMatter.get(matter_id) || []), note]);
  const handled = new Set<number>();
  await Promise.all(batches.map(async (batch) => {
    try {
      const updates = await generate(batch, opts.signal);
      const notes = new Map(batch.filter((m) => notesByMatter.has(m.id)).map((m) => [m.id, notesByMatter.get(m.id)!]));
      const first = await checkAll(batch, updates, notes, opts.signal);
      const at = new Date().toISOString();
      const stamp = (u: Update, problems: Problem[], firstCount: number, edited: boolean) => {
        u.meta.summary_check = { at, problems: problems.length, first_problems: firstCount, rewritten: false, ...(edited ? { edited: true } : {}),
          ...(problems.length ? { unresolved: problems } : {}) };
      };
      for (const [mid, update] of updates) {
        stamp(update, first.problems.get(mid) || [], (first.problems.get(mid) || []).length, false);
        if (opts.dryRun) { opts.onUpdate?.(mid, update); report.written.push(mid); handled.add(mid); continue; }
        const { error } = await supabase.from("matters").update(await keepTextEdits(supabase, mid, update)).eq("id", mid);
        if (error) console.error(`[topic-summaries] saving topic ${mid} failed:`, error.message);
        else { report.written.push(mid); handled.add(mid); }
      }
      // Anything the check found goes straight to a direct edit of the saved text, then one more check.
      const failing = [...updates.keys()].filter((mid) => handled.has(mid)
        && ((first.problems.get(mid) || []).length || first.unfollowed.some((u) => u.matter_id === mid)));
      const edits = new Map<number, Update>();
      if (!opts.dryRun && !opts.signal?.aborted) {
        await Promise.all(failing.map(async (mid) => {
          const mine = first.unfollowed.filter((u) => u.matter_id === mid);
          const edit = await directEdit(supabase, mid, editInstructions(mine.map((u) => u.note), first.problems.get(mid) || []),
            { lock: mine.length > 0, signal: opts.signal });
          if (!edit) return;
          report.edited.push(mid);
          const u = updates.get(mid)!;
          edits.set(mid, { ...u, plain_english_summary: edit.summary || u.plain_english_summary,
            meta: { ...u.meta, status_line: edit.status_line || u.meta.status_line } });
        }));
      }
      const final = edits.size ? await checkAll(batch, edits, new Map([...notes].filter(([m]) => edits.has(m))), opts.signal) : null;
      for (const mid of updates.keys()) {
        const settled = final && edits.has(mid);
        const problems = settled ? final.problems.get(mid) || [] : first.problems.get(mid) || [];
        report.problems.set(mid, problems);
        report.unfollowed.push(...(settled ? final.unfollowed.filter((u) => u.matter_id === mid) : first.unfollowed.filter((u) => u.matter_id === mid)));
        if (settled && !final.failed) {
          const u = edits.get(mid)!;
          stamp(u, problems, (first.problems.get(mid) || []).length, true);
          const { data: row } = await supabase.from("matters").select("meta").eq("id", mid).single();
          await supabase.from("matters").update({ meta: { ...(row?.meta || {}), summary_check: u.meta.summary_check } }).eq("id", mid);
        }
      }
    } catch (error) {
      console.error(`[topic-summaries] topics ${batch.map((m) => m.id).join(", ")}:`, error instanceof Error ? error.message : error);
    }
  }));
  // An instruction for a topic that wasn't written can't be claimed either.
  for (const [matter_id, list] of notesByMatter) {
    if (!handled.has(matter_id)) report.unfollowed.push(...list.map((note) => ({ note, matter_id, missing: "" })));
  }
  report.written.sort((a, b) => a - b);
  return report;
}

/** Rewrite and check the summaries of these topics, and save them. Returns the ids written. */
export async function refreshTopicSummaries(supabase: SupabaseClient, matterIds: Iterable<number>,
  opts: { dryRun?: boolean; onUpdate?: (matterId: number, update: Update) => void; signal?: AbortSignal } = {}): Promise<number[]> {
  return (await rewriteSummaries(supabase, matterIds, opts)).written;
}

const NoteCheck = z.object({
  followed: z.boolean().describe(FIELDS.note_followed),
  missing: z.string().describe(FIELDS.note_missing),
});

/** The approved summary instructions the rewritten summary doesn't follow, each with the topic the page now shows
 * and what is still missing. */
export async function checkSummaryNotes(supabase: SupabaseClient, notes: { matter_id: number; note: string }[]) {
  return (await Promise.all(notes.map(async (entry) => {
    let matterId = entry.matter_id;
    let { data: matter } = await supabase.from("matters").select("plain_english_summary, meta, merged_into").eq("id", matterId).single();
    if (matter?.merged_into) {  // merged away during this fix: the page now shows the topic it was merged into
      matterId = matter.merged_into;
      ({ data: matter } = await supabase.from("matters").select("plain_english_summary, meta, merged_into").eq("id", matterId).single());
    }
    const text = `Summary: ${matter?.plain_english_summary || ""}\nWhere it stands: ${matter?.meta?.status_line || ""}`;
    try {
      const { data } = await getAiClient().json({ stage: "note_check", system: DEFAULT_SYSTEM, schema: NoteCheck, schemaName: "_NoteCheck",
        prompt: `An editor asked for this change to a topic page's summary on a site that follows a city council:\n\n${entry.note}\n\n`
          + `The page now reads:\n${text}\n\nThe page's dates (when it was discussed) and its timeline are drawn from its records `
          + `and shown separately, so judge only what the summary and status should say. Judge substance, not wording: it follows `
          + `the instruction when the facts it asks for are there (in the summary or the status) and nothing it says to drop is `
          + `left; asides such as "noting that…" are optional. Does it follow the instruction?` });
      return data.followed ? null : { note: entry.note, matter_id: matterId, missing: data.missing };
    } catch (error) {  // can't check: say so rather than claim it
      console.error("[topic-summaries] summary check failed:", error instanceof Error ? error.message : error);
      return { note: entry.note, matter_id: matterId, missing: "" };
    }
  }))).filter((u): u is { note: string; matter_id: number; missing: string } => !!u);
}

const DirectEdit = z.object({
  summary: z.string().describe(FIELDS.direct_summary),
  status_line: z.string().describe(FIELDS.direct_status_line),
});

/** Applies instructions to the current summary and status line directly, using only the instructions and the record's
 * words they quote. With `lock` (the default) the result is kept as meta.staff_text, which later rewrites keep until
 * the topic gains a step of its own; without it, it is a plain correction. Returns the saved text, or null. */
export async function directEdit(supabase: SupabaseClient, matterId: number, notes: string[],
  opts: { lock?: boolean; signal?: AbortSignal } = {}): Promise<{ summary: string; status_line: string } | null> {
  const lock = opts.lock ?? true;
  const { data: m } = await supabase.from("matters").select("plain_english_summary, meta").eq("id", matterId).single();
  const meta: Meta = m?.meta || {};
  let edit: z.infer<typeof DirectEdit>;
  try {
    ({ data: edit } = await getAiClient().json({ stage: "review", system: DEFAULT_SYSTEM, schema: DirectEdit, schemaName: "_DirectEdit", signal: opts.signal,
      prompt: "Apply these approved instructions to a topic page on a site that follows a city council. Change only what they ask; "
        + "keep everything else, and use only facts the instructions or their quoted records give.\n\nInstructions:\n"
        + notes.map((n) => `- ${n}`).join("\n")
        + `\n\nCurrent summary: ${m?.plain_english_summary || ""}\nCurrent where it stands: ${meta.status_line || ""}` }));
  } catch (error) {
    console.error("[topic-summaries] direct edit failed:", error instanceof Error ? error.message : error);
    return null;
  }
  const summary = edit.summary.trim() || (m?.plain_english_summary ?? "");
  const status_line = edit.status_line.trim() || (meta.status_line ?? "");
  const owned = lock ? await fetchAll<{ id: number }>((from, to) => supabase.from("agenda_items").select("id").eq("matter_id", matterId).order("id").range(from, to)) : [];
  const staffText = { summary: edit.summary.trim(), status_line: edit.status_line.trim(), items: owned.map((r) => r.id).sort((a, b) => a - b),
    notes, at: new Date().toISOString() };
  const { error } = await supabase.from("matters").update(await keepTextEdits(supabase, matterId, {
    plain_english_summary: summary,
    meta: { ...meta, status_line, ...(lock ? { staff_text: staffText } : {}) },
  })).eq("id", matterId);
  return error ? null : { summary, status_line };
}
