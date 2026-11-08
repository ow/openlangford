import type { SupabaseClient } from "@supabase/supabase-js";
import type { FlagResearch, PageFlag } from "../lib/page-review-types";
import { itemRecords, mapLimit } from "./page-verify.server";
import { readRecord, research, type ResearchGoal } from "./record-research.server";

/**
 * The fix agent's investigation, before it plans: for every flag staff agreed with (and their note), it searches and
 * reads the City's records itself (`research` in record-research.server.ts), with a question that fits the problem:
 * what was proposed and what Council decided; how a record relates to this topic; whether two topics are one project.
 * The findings, with the record's own words and refs, go into the plan prompt beside their flag, and the records they
 * rest on go to the re-check, so the re-check reads what the agent read.
 *
 * All the investigations run at once under the fix's deadline, each capped at INVESTIGATION_TURNS turns and together
 * at INVESTIGATION_MS: one research turn on the review model takes about 2 s plus 12 ms per output token (ai_usage,
 * web review stage, 14 days to 2026-11-06), so about 4 s, and a four-flag fix's investigation about 15-20 s.
 */

export const INVESTIGATION_TURNS = 6;
export const INVESTIGATION_MS = 40_000;
/** Investigations running at once (each is one model call per turn plus a few searches). */
const PARALLEL = 4;

const ANSWER: ResearchGoal = {
  task: "answer one question an editor needs answered before a page is fixed",
  finish: "Finish when you can answer it from the records: verdict supported when the records answer it (the answer in "
    + "explanation, with the words it rests on quoted), contradicted when they show the page is wrong, not_found when "
    + "you searched and they don't say. Never call a meeting's record silent before you have read that meeting's minutes. "
    + "Say what the records show, not what should be done to the page: the editor and the agent decide that. Give one "
    + "ref in ref.",
};

export type Investigation = {
  /** The flag's index in the page's flags, or null for the editor's note. */
  index: number | null;
  key: string | null;
  question: string;
  finding: FlagResearch | null;
};

const itemOf = (key: string | null) => Number(key?.match(/^(?:agenda|mention|background|item)-(\d+)$/)?.[1] ?? NaN);

/**
 * Whether a flag needs the records searched before the plan. The plan already holds the topic's own records, the
 * records of every related topic and of any topic holding an accepted entry, so a related-topic flag, a duplicate
 * and a page-level problem (a cut-off sentence, a stale description) are judged from those: researching them again
 * costs the whole investigation's time (run 2026-11-08: a related-topic question ran to the 40 s cap unanswered)
 * and finds nothing the plan lacks.
 */
export function needsInvestigation(flag: PageFlag): boolean {
  if (/^related-\d+$/.test(flag.key ?? "")) return false;
  return flag.problem !== "duplicate" && flag.problem !== "page_issue";
}

/** The question to research for one agreed flag, by the kind of problem and the kind of entry. */
export function investigationQuestion(flag: PageFlag, topic: string): string {
  const key = flag.key ?? "";
  const entry = `The entry reads: "${flag.excerpt}". The problem staff agreed with: ${flag.reason}`;
  if (flag.problem === "unsupported" || flag.problem === "wrong_detail") {
    return `What does the City's record actually say about this? The page says: "${flag.excerpt}". The problem found: ${flag.reason}`;
  }
  const related = key.match(/^related-(\d+)$/)?.[1];
  if (related) {
    return `Is topic ${related} the very same project as "${topic}" (the same policy, bylaw, application or site), a separate `
      + `project about the same place, or about something else? ${entry}`;
  }
  if (/^(mention|background|report|evidence)-/.test(key) && flag.problem !== "generic_text") {
    return `How does this record relate to "${topic}"? Does it name it, or the same policy, bylaw, site, process or project? `
      + `A record about the same subject, even an earlier or separate step, is connected: say in one plain sentence what `
      + `the connection is (what this step did, and how it bears on "${topic}"). Call it unrelated only if the record is `
      + `about something else, and say what. ${entry}`;
  }
  if (/^(agenda|item)-/.test(key) || flag.problem === "generic_text" || flag.problem === "duplicate") {
    return `What was proposed at this step of "${topic}", and what did Council decide? Read that meeting's minutes (search `
      + `the item's subject) before saying the record doesn't say. ${entry}`;
  }
  return `What do the City's records say about this problem with the page on "${topic}"? ${entry}`;
}

/** A finding in a line: the answer, then the record's words and where they are. "" for none. */
export function findingText(f: FlagResearch | null | undefined): string {
  return f ? `${f.verdict}. ${f.explanation}${f.quote ? ` The record says: “${f.quote}”${f.ref ? ` (${f.ref})` : ""}` : ""}` : "";
}

/** One investigation as the re-check reads it, among the records. */
export function investigationLine(i: Investigation): string {
  return i.finding ? `FOUND for [${i.key ?? "whole page"}] (the fix agent searched the City's records): ${findingText(i.finding)}` : "";
}

/**
 * Investigates every agreed flag that needs it (`needsInvestigation`) and has no stored finding (a check that raised
 * a flag on a statement already researched it), and the editor's note, in parallel. Each research session knows the
 * deadline, so it gives its finding from what it has read rather than being cut off. Never throws: an investigation
 * that fails or runs out of time leaves its finding null, and the plan goes ahead with the records it has.
 */
export async function investigate(supabase: SupabaseClient, input: {
  path: string; topic: string; flags: { flag: PageFlag; index: number }[]; note: string | null; signal: AbortSignal;
  maxTurns?: number; timeoutMs?: number;
  /** Records every investigation starts with (the topic's signed bylaws). */
  records?: string;
}): Promise<Investigation[]> {
  const timeoutMs = input.timeoutMs ?? INVESTIGATION_MS;
  const deadline = Date.now() + timeoutMs;
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(timeoutMs)]);
  const jobs: Investigation[] = input.flags.filter(({ flag }) => flag.research || needsInvestigation(flag)).map(({ flag, index }) => ({
    index, key: flag.key, question: investigationQuestion(flag, input.topic), finding: flag.research ?? null,
  }));
  if (input.note?.trim()) {
    jobs.push({ index: null, key: null, finding: null,
      question: `An editor asked this about the page on "${input.topic}": ${input.note.trim()} What do the City's records say that answers it?` });
  }
  const flagOf = (job: Investigation) => (job.index === null ? null : input.flags.find((f) => f.index === job.index)?.flag ?? null);
  await mapLimit(jobs.filter((job) => !job.finding), PARALLEL, async (job) => {
    const flag = flagOf(job);
    // What the agent already has for this entry: the item's own records, its meeting's minutes included.
    const item = itemOf(job.key);
    const own = Number.isSafeInteger(item) ? (await itemRecords(supabase, [item]).catch(() => ({ text: "" }))).text : "";
    const context = [`This is the topic page ${input.path} ("${input.topic}").`,
      flag?.fix ? `The fix staff approved: ${flag.fix}` : "", flag?.note ? `The editor's note on this entry: ${flag.note}` : "",
      input.records ? `THE TOPIC'S SIGNED BYLAWS:\n${input.records}` : "",
      own ? `THE ENTRY'S OWN RECORDS (item:${item}):\n${own}` : ""].filter(Boolean).join("\n");
    try {
      const found = await research(supabase, job.question, context, input.maxTurns ?? INVESTIGATION_TURNS, signal, ANSWER, deadline);
      job.finding = { verdict: found.verdict, explanation: found.explanation, quote: found.quote, ref: found.ref };
    } catch (error) {
      if (!signal.aborted) console.error("[page-fix] investigation failed:", error instanceof Error ? error.message : error);
    }
  });
  return jobs;
}

/** The whole records the findings rest on (each ref read once), for the re-check, so it reads what the agent read. */
export async function investigatedRecords(supabase: SupabaseClient, investigations: Investigation[]): Promise<string> {
  // A finding may name more than one ref ("item:973; section:5132").
  const refs = [...new Set(investigations.flatMap((i) => (i.finding?.ref || "").split(/[;,\s]+/))
    .filter((r) => /^[a-z]+:\d+(:[\d.]+)?$/.test(r)))];
  const texts = await Promise.all(refs.map(async (ref) => {
    const text = await readRecord(supabase, ref).catch(() => "");
    return text && !text.startsWith("No record") && !text.startsWith("Unknown reference") ? `RECORD ${ref} (read by the fix agent):\n${text}` : "";
  }));
  return texts.filter(Boolean).join("\n\n");
}
