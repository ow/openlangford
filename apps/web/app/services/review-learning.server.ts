import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { getAiClient } from "./ai/index.server";
import type { FlagProblem, FlagVerdict, PageFlag } from "../lib/page-review-types";

/**
 * How the page check learns, for good:
 * - every staff rating of a flag is a labelled example (review_examples), kept permanently;
 * - each check gets the examples most like the page it's reading, per page kind and problem type, balanced between
 *   flags staff agreed with and flags they rejected;
 * - written guidance per problem type is drafted from all the examples, edited and approved by staff, and goes into
 *   every check (review_guidance); each check records the guidance version it used, so agreement can be compared
 *   across versions.
 */

export const CHECKED_PROBLEMS: FlagProblem[] = ["unclear_why", "generic_text", "different_story", "duplicate", "wrong_detail", "unsupported"];
const PER_VERDICT = 3;

export type Example = { problem: FlagProblem; entry_text: string; reason: string; verdict: FlagVerdict; note?: string | null };
export type Guidance = { id: number; problem: string; page_kind: string | null; text: string; status: string; based_on: number; created_at: string };

const embed = async (text: string): Promise<number[] | null> => {
  try {
    const [vector] = await getAiClient().embed([text.slice(0, 6000)]);
    return vector ?? null;
  } catch {
    return null;  // examples still work by recency without one
  }
};

/** Record (or update) a rated flag as a permanent example; a cleared rating removes it. */
export async function recordExample(supabase: SupabaseClient, input: {
  path: string; kind: string; flag: PageFlag; userId?: string | null; model?: string | null; guidanceVersion?: number | null;
}) {
  const { flag } = input;
  if (flag.problem === "editor_issue") return;
  const match = { path: input.path, entry_key: flag.key, problem: flag.problem, reason: flag.reason };
  if (!flag.verdict) {
    let q = supabase.from("review_examples").delete().eq("path", match.path).eq("problem", match.problem).eq("reason", match.reason);
    q = match.entry_key === null ? q.is("entry_key", null) : q.eq("entry_key", match.entry_key);
    await q;
    return;
  }
  const embedding = await embed(`${flag.excerpt}\n${flag.reason}`);
  const { error } = await supabase.from("review_examples").upsert({
    ...match, page_kind: input.kind, entry_text: flag.excerpt, verdict: flag.verdict, note: flag.note ?? null,
    model: input.model ?? null, guidance_version: input.guidanceVersion ?? null, rated_by: input.userId ?? null,
    embedding, updated_at: new Date().toISOString(),
  }, { onConflict: "path,entry_key,problem,reason" });
  if (error) console.error("[review-learning] could not record example:", error.message);
}

/** The examples most like this page: for each problem type, the closest agreed and rejected flags on this kind of
 * page (any kind when there are too few). */
export async function examplesFor(supabase: SupabaseClient, kind: string, pageText: string): Promise<Example[]> {
  const embedding = await embed(pageText);
  const out: Example[] = [];
  await Promise.all(CHECKED_PROBLEMS.flatMap((problem) => (["agree", "disagree"] as const).map(async (verdict) => {
    const ask = (k: string | null) => supabase.rpc("match_review_examples",
      { query_embedding: embedding, kind: k, problem_type: problem, verdict_type: verdict, k: PER_VERDICT });
    let { data } = await ask(kind);
    if ((data?.length ?? 0) < 2) ({ data } = await ask(null));
    for (const row of (data || []) as any[]) {
      out.push({ problem, entry_text: row.entry_text, reason: row.reason, verdict, note: row.note });
    }
  })));
  return out;
}

/** Approved guidance for checks of this kind of page, and its version (the newest approved rule's id). */
export async function approvedGuidance(supabase: SupabaseClient, kind: string): Promise<{ rules: Guidance[]; version: number | null }> {
  const { data } = await supabase.from("review_guidance").select("*").eq("status", "approved").order("id");
  const rules = ((data || []) as Guidance[]).filter((g) => !g.page_kind || g.page_kind === kind);
  return { rules, version: rules.length ? Math.max(...rules.map((g) => g.id)) : null };
}

const DraftSchema = z.object({
  rule: z.string().describe("At most three plain sentences telling the checker when to flag this problem and when not to."),
  page_kind: z.string().nullable().describe("A page kind (matters, meetings, people, properties...) if the rule only applies there, else null."),
});

/** Draft a rule for one problem type from every rating of it; staff edit and approve it on /admin/reviews. */
export async function draftGuidance(supabase: SupabaseClient, problem: FlagProblem, label: string) {
  const { data } = await supabase.from("review_examples").select("page_kind, entry_text, reason, verdict, note")
    .eq("problem", problem).order("created_at", { ascending: false }).limit(200);
  const rows = (data || []) as { page_kind: string; entry_text: string; reason: string; verdict: string; note: string | null }[];
  if (rows.length < 3) throw new Error("Rate a few more flags of this kind first.");
  const { data: current } = await supabase.from("review_guidance").select("text").eq("problem", problem).eq("status", "approved");
  const prompt = `You maintain the instructions for a checker that reads pages of Open Langford (a site that follows
Langford City council) and flags "${label}" problems. An editor rated its flags: AGREED means it was a real problem,
REJECTED means it shouldn't have been flagged. Write the rule that would have produced the editor's verdicts: when to
flag "${label}" and, just as important, when not to. Generalize; don't list cases.
${(current || []).length ? `\nThe current rule (improve it, keep what still holds):\n${(current || []).map((c: any) => `- ${c.text}`).join("\n")}\n` : ""}
Ratings:
${rows.map((r) => `- ${r.verdict === "agree" ? "AGREED" : "REJECTED"} on a ${r.page_kind} page: ${r.reason} (entry: "${r.entry_text}")${r.note ? ` Editor's note: ${r.note}` : ""}`).join("\n")}`;
  const result = await getAiClient().json({ stage: "review", prompt, schema: DraftSchema, schemaName: "guidance_draft" });
  const { error } = await supabase.from("review_guidance").insert({
    problem, page_kind: result.data.page_kind, text: result.data.rule.trim(), status: "draft", based_on: rows.length,
  });
  if (error) throw new Error("Could not save the draft.");
}

/** Approve (replacing the problem's current rule), edit, or drop a guidance rule. */
export async function decideGuidance(supabase: SupabaseClient, id: number, decision: "approve" | "reject", text: string | null, userId: string) {
  const { data: rule } = await supabase.from("review_guidance").select("id, problem, page_kind").eq("id", id).single();
  if (!rule) throw new Error("No such rule.");
  const now = new Date().toISOString();
  if (decision === "approve") {
    let retire = supabase.from("review_guidance").update({ status: "retired", decided_at: now }).eq("status", "approved")
      .eq("problem", rule.problem).neq("id", id);
    retire = rule.page_kind ? retire.eq("page_kind", rule.page_kind) : retire.is("page_kind", null);
    await retire;
  }
  const { error } = await supabase.from("review_guidance").update({
    status: decision === "approve" ? "approved" : "retired", decided_by: userId, decided_at: now,
    ...(text && text.trim() ? { text: text.trim().slice(0, 1500) } : {}),
  }).eq("id", id);
  if (error) throw new Error("Could not save the rule.");
}

export type LearningRow = {
  problem: FlagProblem; rated: number; agreed: number; sinceDraft: number;
  approved: Guidance | null; draft: Guidance | null;
  byVersion: { version: number | null; rated: number; agreed: number }[];
};

/** Per problem type: how often staff agree, by guidance version, and where its written rule stands. */
export async function learningOverview(supabase: SupabaseClient): Promise<LearningRow[]> {
  const [{ data: examples }, { data: guidance }] = await Promise.all([
    supabase.from("review_examples").select("problem, verdict, guidance_version, created_at").limit(20000),
    supabase.from("review_guidance").select("*").neq("status", "retired").order("id", { ascending: false }),
  ]);
  const rows = (examples || []) as { problem: FlagProblem; verdict: string; guidance_version: number | null; created_at: string }[];
  const rules = (guidance || []) as Guidance[];
  return CHECKED_PROBLEMS.map((problem) => {
    const mine = rows.filter((r) => r.problem === problem);
    const approved = rules.find((g) => g.problem === problem && g.status === "approved") ?? null;
    const draft = rules.find((g) => g.problem === problem && g.status === "draft") ?? null;
    const lastDraftAt = (draft || approved)?.created_at ?? "";
    const versions = new Map<number | null, { rated: number; agreed: number }>();
    for (const r of mine) {
      const v = versions.get(r.guidance_version) ?? { rated: 0, agreed: 0 };
      v.rated++; if (r.verdict === "agree") v.agreed++;
      versions.set(r.guidance_version, v);
    }
    return {
      problem, rated: mine.length, agreed: mine.filter((r) => r.verdict === "agree").length,
      sinceDraft: mine.filter((r) => r.created_at > lastDraftAt).length, approved, draft,
      byVersion: [...versions].map(([version, v]) => ({ version, ...v })).sort((a, b) => (a.version ?? 0) - (b.version ?? 0)),
    };
  });
}
