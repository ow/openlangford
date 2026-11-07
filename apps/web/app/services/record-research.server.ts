import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { getAiClient } from "./ai/index.server";
import { fetchAll } from "./page-verify.server";
import { completeVoteCounts } from "../lib/vote-coverage";
import { bylawRecordLine, readBylaw, searchBylaws } from "./bylaw-records.server";

/**
 * The City's records as a library the review model can research, not just the text pre-loaded beside a page. A
 * fact on a topic page often lives in a report filed under another meeting, the minutes of a committee, or what was
 * said on video. The model searches (full text across report sections, motions, agenda items, transcripts and the
 * City's annual reports), reads any hit in full, and finishes with what the record says and where.
 *
 * Search previews are only an index; a read always returns the whole record. Nothing is cut: when the research
 * would outgrow one request, the model is told so and must finish with what it has.
 */

export type RecordHit = { ref: string; kind: string; date: string | null; title: string; preview: string };

const PER_KIND = 8;
const RESEARCH_BUDGET = 1_500_000;  // characters of observations in one research session

const quoteOf = (text: string, query: string) => {
  // A short preview around the first query word found, so the model can choose what to read.
  const flat = text.replace(/\s+/g, " ").trim();
  const words = query.toLowerCase().split(/\W+/).filter((w) => w.length > 3);
  const at = words.map((w) => flat.toLowerCase().indexOf(w)).filter((i) => i >= 0).sort((a, b) => a - b)[0] ?? 0;
  const start = Math.max(0, at - 150);
  return `${start > 0 ? "…" : ""}${flat.slice(start, start + 400)}${start + 400 < flat.length ? "…" : ""}`;
};
const meetingOf = (row: any) => (Array.isArray(row?.meetings) ? row.meetings[0] : row?.meetings) || {};

/** Full-text search across the City's records; previews only, `readRecord` returns the whole thing. */
export async function searchRecords(supabase: SupabaseClient, query: string): Promise<RecordHit[]> {
  const ts = { type: "websearch" as const, config: "english" };
  const [sections, motions, items, segments, pages, bylaws] = await Promise.all([
    supabase.from("document_sections").select("id, agenda_item_id, section_title, section_text, documents(title, meetings(meeting_date))")
      .textSearch("text_search", query, ts).limit(PER_KIND),
    supabase.from("motions").select("id, text_content, result, meetings(meeting_date)").textSearch("text_search", query, ts).limit(PER_KIND),
    supabase.from("agenda_items").select("id, title, plain_english_summary, meetings(meeting_date)").textSearch("text_search", query, ts).limit(PER_KIND),
    supabase.from("transcript_segments").select("meeting_id, start_time, speaker_name, text_content, meetings(meeting_date)")
      .textSearch("text_search", query, ts).limit(PER_KIND),
    supabase.from("public_report_pages").select("report_id, page, content, public_reports(year, title)").textSearch("text_search", query, ts).limit(PER_KIND),
    searchBylaws(supabase, query).catch(() => []),
  ]);
  const hits: RecordHit[] = [];
  for (const b of bylaws) {
    hits.push({ ref: `bylaw:${b.id}`, kind: "signed bylaw (its certified reading and adoption dates)", date: null,
      title: `Bylaw No. ${b.bylaw_number || "?"}: ${b.title || "untitled"}`, preview: bylawRecordLine(b) });
  }
  for (const s of (sections.data || []) as any[]) {
    const doc = Array.isArray(s.documents) ? s.documents[0] : s.documents;
    hits.push({ ref: `section:${s.id}`, kind: "report or minutes section", date: meetingOf(doc).meeting_date ?? null,
      title: `${doc?.title || "Document"}${s.section_title ? ` — ${s.section_title}` : ""}${s.agenda_item_id ? ` (filed under item:${s.agenda_item_id})` : ""}`,
      preview: quoteOf(s.section_text || "", query) });
  }
  for (const m of (motions.data || []) as any[]) {
    hits.push({ ref: `motion:${m.id}`, kind: "motion", date: meetingOf(m).meeting_date ?? null, title: `Motion (${m.result || "no result"})`,
      preview: quoteOf(m.text_content || "", query) });
  }
  for (const i of (items.data || []) as any[]) {
    hits.push({ ref: `item:${i.id}`, kind: "agenda item (title, and a model-written summary)", date: meetingOf(i).meeting_date ?? null,
      title: String(i.title || "").split("\n")[0], preview: quoteOf(`${i.title}. ${i.plain_english_summary || ""}`, query) });
  }
  for (const t of (segments.data || []) as any[]) {
    hits.push({ ref: `transcript:${t.meeting_id}:${t.start_time}`, kind: "meeting video transcript", date: meetingOf(t).meeting_date ?? null,
      title: `Said by ${t.speaker_name || "a speaker"} (speaker names are a machine's guess)`, preview: quoteOf(t.text_content || "", query) });
  }
  for (const p of (pages.data || []) as any[]) {
    const r = Array.isArray(p.public_reports) ? p.public_reports[0] : p.public_reports;
    hits.push({ ref: `report:${p.report_id}:${p.page}`, kind: "City annual report page", date: r?.year ? String(r.year) : null,
      title: `${r?.title || "Annual report"}, page ${p.page}`, preview: quoteOf(p.content || "", query) });
  }
  return hits;
}

/** The whole record behind a reference from `searchRecords` (or an item id), never an excerpt. */
export async function readRecord(supabase: SupabaseClient, ref: string): Promise<string> {
  const [kind, a, b] = ref.split(":");
  const id = Number(a);
  if (kind === "section" && Number.isSafeInteger(id)) {
    const { data } = await supabase.from("document_sections")
      .select("section_title, section_text, agenda_item_id, documents(title, meetings(meeting_date, title))").eq("id", id).maybeSingle();
    if (!data) return `No record ${ref}.`;
    const doc = Array.isArray((data as any).documents) ? (data as any).documents[0] : (data as any).documents;
    return `${doc?.title || "Document"} (${meetingOf(doc).title || "meeting"}, ${meetingOf(doc).meeting_date || "date unknown"})` +
      `${data.agenda_item_id ? `, filed under agenda item ${data.agenda_item_id}` : ""}\n${data.section_title ? `${data.section_title}\n` : ""}${data.section_text}`;
  }
  if (kind === "motion" && Number.isSafeInteger(id)) {
    const { data } = await supabase.from("motions")
      .select("text_content, result, mover, seconder, meta, agenda_item_id, votes(person_id, vote), meetings(meeting_date, title)").eq("id", id).maybeSingle();
    if (!data) return `No record ${ref}.`;
    const counts = completeVoteCounts(data as any);
    return `Motion at ${meetingOf(data).title || "a meeting"} (${meetingOf(data).meeting_date || "date unknown"}), agenda item ${data.agenda_item_id}:\n` +
      `${data.text_content}\nRESULT: ${data.result || "not recorded"}${counts ? ` (vote ${counts.yes}–${counts.no})` : ""}` +
      `${data.mover ? `; moved by ${data.mover}` : ""}${data.seconder ? `, seconded by ${data.seconder}` : ""}`;
  }
  if (kind === "item" && Number.isSafeInteger(id)) {
    const { data: item } = await supabase.from("agenda_items")
      .select("title, meeting_id, discussion_start_time, discussion_end_time, meetings(meeting_date, title)").eq("id", id).maybeSingle();
    if (!item) return `No record ${ref}.`;
    const [motions, sections] = await Promise.all([
      fetchAll<any>((from, to) => supabase.from("motions").select("id, text_content, result").eq("agenda_item_id", id).order("id").range(from, to)),
      fetchAll<any>((from, to) => supabase.from("document_sections").select("section_title, section_text, documents(title)")
        .eq("agenda_item_id", id).order("section_order").order("id").range(from, to)),
    ]);
    const transcript = item.discussion_start_time != null
      ? await transcriptText(supabase, item.meeting_id, item.discussion_start_time, item.discussion_end_time ?? item.discussion_start_time + 1800) : "";
    return [`Agenda item ${id}: ${item.title} (${meetingOf(item).title || "meeting"}, ${meetingOf(item).meeting_date || "date unknown"})`,
      ...motions.map((m) => `MOTION motion:${m.id}: ${m.text_content} | RESULT: ${m.result || "not recorded"}`),
      ...sections.map((s) => { const doc = Array.isArray(s.documents) ? s.documents[0] : s.documents;
        return `DOCUMENT ${doc?.title || ""}${s.section_title ? ` — ${s.section_title}` : ""}:\n${s.section_text}`; }),
      transcript ? `VIDEO TRANSCRIPT OF THE DISCUSSION (speaker names are a machine's guess):\n${transcript}` : ""].filter(Boolean).join("\n\n");
  }
  if (kind === "transcript" && Number.isSafeInteger(id)) {
    // The whole discussion the line belongs to: the agenda item whose window holds it, or the 30 minutes around it.
    const at = Number(b);
    const { data: items } = await supabase.from("agenda_items").select("id, title, discussion_start_time, discussion_end_time")
      .eq("meeting_id", id).not("discussion_start_time", "is", null).lte("discussion_start_time", at)
      .order("discussion_start_time", { ascending: false }).limit(1);
    const item = (items || [])[0] as any;
    const start = item?.discussion_start_time ?? Math.max(0, at - 900);
    const end = item ? (item.discussion_end_time ?? start + 1800) : at + 900;
    return `${item ? `Discussion of agenda item ${item.id}: ${item.title}` : `Meeting ${id}, around ${Math.round(at)}s`}\n` +
      `(speaker names are a machine's guess)\n${await transcriptText(supabase, id, start, end)}`;
  }
  if (kind === "bylaw" && Number.isSafeInteger(id)) {
    return (await readBylaw(supabase, id)) ?? `No record ${ref}.`;
  }
  if (kind === "report" && Number.isSafeInteger(id)) {
    const { data } = await supabase.from("public_report_pages").select("content, public_reports(year, title)")
      .eq("report_id", id).eq("page", Number(b)).maybeSingle();
    if (!data) return `No record ${ref}.`;
    const r = Array.isArray((data as any).public_reports) ? (data as any).public_reports[0] : (data as any).public_reports;
    return `${r?.title || "Annual report"} ${r?.year || ""}, page ${b}:\n${data.content}`;
  }
  return `Unknown reference ${ref}. Use a ref exactly as a search returned it, or item:<agenda item id>.`;
}

async function transcriptText(supabase: SupabaseClient, meetingId: number, start: number, end: number) {
  const rows = await fetchAll<any>((from, to) => supabase.from("transcript_segments").select("speaker_name, text_content")
    .eq("meeting_id", meetingId).gte("start_time", start).lt("start_time", end).order("start_time").range(from, to));
  return rows.map((r) => `${r.speaker_name || "Speaker"}: ${r.text_content}`).join("\n");
}

const StepSchema = z.object({
  thought: z.string().describe("One or two sentences: what you know so far and what you will look at next."),
  actions: z.array(z.object({
    type: z.enum(["search", "read"]),
    query: z.string().nullable().describe("For search: words to look for (names, numbers, addresses, bylaw numbers)."),
    ref: z.string().nullable().describe("For read: a ref exactly as a search returned it, or item:<agenda item id>."),
  })).describe("Searches and reads to run now, all at once (several are fine). Empty when you finish."),
  finding: z.object({
    verdict: z.enum(["supported", "contradicted", "not_found"]),
    quote: z.string().nullable().describe("The record's own words that support or contradict it, quoted exactly."),
    ref: z.string().nullable().describe("The ref those words came from."),
    explanation: z.string().describe("One plain sentence."),
  }).nullable().describe("Your answer, once you know it; null while you are still looking."),
});

/** One research turn. A reply that doesn't parse is asked again. */
async function nextStep(prompt: string, signal?: AbortSignal): Promise<z.infer<typeof StepSchema>> {
  for (let attempt = 1; ; attempt++) {
    try {
      const { data } = await getAiClient().json({ stage: "review", prompt, schema: StepSchema, schemaName: "record_research", signal });
      return data;
    } catch (error) {
      if (attempt >= 3 || signal?.aborted) throw error;
    }
  }
}

export type ResearchFinding = { verdict: "supported" | "contradicted" | "not_found"; quote: string | null; ref: string | null;
  explanation: string; steps: number };

/** What a research session is for: the opening task and when to finish. The page check checks one statement; the fix
 * agent answers a question about a flagged entry (what Council decided, how a record relates to the topic). */
export type ResearchGoal = { task: string; finish: string };
export const CHECK_STATEMENT: ResearchGoal = {
  task: "check one statement",
  finish: "Finish when you know whether the record supports the statement.",
};

/**
 * Research one question in the City's records: each turn the review model runs any number of searches and reads at
 * once (in parallel), until it can say whether the record supports a statement, and where. `context` is what the
 * caller already knows. Bounded by `maxTurns` and by the size of what it has read (RESEARCH_BUDGET), never by cutting
 * a record.
 */
export async function research(supabase: SupabaseClient, question: string, context: string, maxTurns = 10, signal?: AbortSignal,
  goal: ResearchGoal = CHECK_STATEMENT): Promise<ResearchFinding> {
  const log: string[] = [];
  let used = 0;
  for (let turn = 1; turn <= maxTurns + 1; turn++) {
    const last = turn > maxTurns || used > RESEARCH_BUDGET;
    const prompt = `You research Langford City council's own records to ${goal.task}. Search with specific words (an
address, a bylaw or file number, a name, a figure) and read the records that look relevant in full; run several
searches and reads at once when that helps. A report section belongs to an agenda item (read item:<id> for everything
filed on it, with its motions and video transcript). ${goal.finish}
Only the City's records count: motions, reports, minutes, transcripts of the meeting video, annual reports, and signed
bylaws (bylaw:<id>), whose printed reading and adoption dates are the certified record of a bylaw's progress and
outrank a motion's wording in the minutes. For a question about whether a bylaw was read or adopted, search its
number and read the signed bylaw. Agenda item summaries are model-written notes: they can point you somewhere but
don't count as support. Quote the record's own words exactly in your finding.
${last ? "\nYou have used your searches and reads: give your finding now with what you found.\n" : ""}
QUESTION: ${question}

WHAT IS ALREADY KNOWN:
${context}

${log.length ? `YOUR RESEARCH SO FAR:\n${log.join("\n\n")}` : "You have not searched yet."}`;
    const data = await nextStep(prompt, signal);
    if (data.finding || !data.actions.length || last) {
      const f = data.finding ?? { verdict: "not_found" as const, quote: null, ref: null, explanation: data.thought };
      return { ...f, steps: turn };
    }
    const observations = await Promise.all(data.actions.map(async (act) => {
      try {
        if (act.type === "search" && act.query) {
          const hits = await searchRecords(supabase, act.query);
          return `SEARCH "${act.query}":\n` + (hits.length
            ? hits.map((h) => `- ${h.ref} [${h.kind}, ${h.date ?? "date unknown"}] ${h.title}: ${h.preview}`).join("\n")
            : "No records matched. Try other words (fewer, or a number or address).");
        }
        if (act.type === "read" && act.ref) return `READ ${act.ref}:\n${await readRecord(supabase, act.ref)}`;
        return "That action needs a query (search) or a ref (read).";
      } catch (error) {
        return `${act.type} failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    }));
    used += observations.reduce((n, o) => n + o.length, 0);
    log.push(`Turn ${turn} (${data.thought}):\n${observations.join("\n\n")}`);
  }
  return { verdict: "not_found", quote: null, ref: null, explanation: "Research ended without a finding.", steps: maxTurns };
}
