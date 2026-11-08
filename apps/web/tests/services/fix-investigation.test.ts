import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PageFlag } from "../../app/lib/page-review-types";

const research = vi.fn();
const readRecord = vi.fn();
vi.mock("../../app/services/record-research.server", () => ({ research, readRecord }));
vi.mock("../../app/services/page-verify.server", () => ({
  itemRecords: vi.fn(async (_s: unknown, ids: number[]) => ({ text: `ITEM ${ids[0]}: its records and the meeting's minutes`, covered: new Set(ids) })),
  mapLimit: async <T, R>(items: T[], _limit: number, fn: (item: T) => Promise<R>) => Promise.all(items.map(fn)),
}));

const { investigate, investigatedRecords, investigationQuestion, investigationLine, needsInvestigation, INVESTIGATION_TURNS } =
  await import("../../app/services/fix-investigation.server");

const flag = (over: Partial<PageFlag>): PageFlag => ({ key: null, problem: "generic_text", reason: "r", excerpt: "e", verdict: "agree", ...over });
const topic = "Public hearing policy";

describe("the fix agent's questions", () => {
  it("asks what was decided for a step of the topic, and to read the minutes first", () => {
    const q = investigationQuestion(flag({ key: "agenda-973", excerpt: "Staff present public hearing policy" }), topic);
    expect(q).toContain("what did Council decide");
    expect(q).toContain("Read that meeting's minutes");
  });

  it("asks how a linked record relates to the topic", () => {
    const q = investigationQuestion(flag({ key: "mention-11059", problem: "unclear_why" }), topic);
    expect(q).toContain(`How does this record relate to "${topic}"`);
  });

  it("asks whether a related topic is the same project", () => {
    expect(investigationQuestion(flag({ key: "related-1091", problem: "duplicate" }), topic)).toContain("the very same project");
  });

  it("asks what the record says about a statement of fact", () => {
    expect(investigationQuestion(flag({ key: null, problem: "unsupported", excerpt: "Summary: x" }), topic)).toContain("What does the City's record actually say");
  });
});

describe("investigate", () => {
  beforeEach(() => { research.mockReset(); readRecord.mockReset(); });

  it("researches every agreed flag and the note, with the entry's records, under a turn cap", async () => {
    research.mockImplementation(async (_s: unknown, question: string) => question.includes("decide")
      ? { verdict: "supported", explanation: "Council approved the policy on Jan 20, 2020.", quote: "That Council approve Council Policy POL-0155-ADMIN, the Public Hearing Policy. CARRIED.", ref: "section:5132", steps: 2 }
      : { verdict: "not_found", explanation: "Nothing more.", quote: null, ref: null, steps: 4 });
    const stored = { verdict: "contradicted" as const, explanation: "Stored.", quote: "q", ref: "motion:1" };
    const flags = [flag({ key: "agenda-973" }), flag({ key: "mention-11059", problem: "unclear_why" }),
      flag({ key: null, problem: "unsupported", research: stored })];
    const out = await investigate({} as any, { path: "/matters/p", topic, note: "Is the 2012 entry relevant?",
      flags: flags.map((f, index) => ({ flag: f, index })), signal: new AbortController().signal });

    // The flag the check already researched keeps its finding; the other two and the note are researched.
    expect(research).toHaveBeenCalledTimes(3);
    for (const call of research.mock.calls) {
      expect(call[3]).toBe(INVESTIGATION_TURNS);
      expect(call[4]).toBeInstanceOf(AbortSignal);
      expect(call[5].task).toContain("answer one question");
    }
    const first = research.mock.calls.find((c) => String(c[1]).includes("decide"))!;
    expect(first[2]).toContain("THE ENTRY'S OWN RECORDS (item:973)");
    expect(out.map((i) => [i.index, i.key, i.finding?.verdict])).toEqual([
      [0, "agenda-973", "supported"], [1, "mention-11059", "not_found"], [2, null, "contradicted"], [null, null, "not_found"]]);
    expect(out[3].question).toContain("Is the 2012 entry relevant?");
    expect(investigationLine(out[0])).toBe("FOUND for [agenda-973] (the fix agent searched the City's records): supported. Council approved the "
      + "policy on Jan 20, 2020. The record says: “That Council approve Council Policy POL-0155-ADMIN, the Public Hearing Policy. CARRIED.” (section:5132)");
  });

  it("skips flags the plan judges from the records it already holds", async () => {
    expect(needsInvestigation(flag({ key: "related-2985", problem: "different_story" }))).toBe(false);
    expect(needsInvestigation(flag({ key: "agenda-5", problem: "duplicate" }))).toBe(false);
    expect(needsInvestigation(flag({ key: null, problem: "page_issue" }))).toBe(false);
    expect(needsInvestigation(flag({ key: null, problem: "unsupported" }))).toBe(true);
    expect(needsInvestigation(flag({ key: "agenda-5", problem: "generic_text" }))).toBe(true);
    expect(needsInvestigation(flag({ key: "mention-5", problem: "unclear_why" }))).toBe(true);

    research.mockResolvedValue({ verdict: "supported", explanation: "x", quote: null, ref: null, steps: 1 });
    const out = await investigate({} as any, { path: "/p", topic, note: null, signal: new AbortController().signal,
      flags: [{ flag: flag({ key: "related-2985", problem: "different_story" }), index: 0 }, { flag: flag({ key: null, problem: "page_issue" }), index: 1 },
        { flag: flag({ key: "agenda-5", problem: "wrong_detail" }), index: 2 }] });
    expect(research).toHaveBeenCalledTimes(1);
    expect(out.map((i) => i.index)).toEqual([2]);
    // The research session is told the deadline, so it can finish on its own before the fix cuts it off.
    expect(typeof research.mock.calls[0][6]).toBe("number");
    expect(research.mock.calls[0][6]).toBeGreaterThan(Date.now());
  });

  it("leaves a finding empty when its research fails or runs out of time, and goes on", async () => {
    research.mockRejectedValueOnce(new Error("timeout")).mockResolvedValueOnce({ verdict: "supported", explanation: "x", quote: null, ref: null, steps: 1 });
    const out = await investigate({} as any, { path: "/p", topic, note: null, signal: new AbortController().signal,
      flags: [{ flag: flag({ key: "agenda-1" }), index: 0 }, { flag: flag({ key: "agenda-2" }), index: 1 }] });
    expect(out.map((i) => i.finding?.verdict ?? null)).toEqual([null, "supported"]);
  });

  it("stops at the fix's deadline", async () => {
    research.mockImplementation((_s, _q, _c, _t, signal: AbortSignal) => new Promise((_, reject) =>
      signal.addEventListener("abort", () => reject(new Error("aborted")))));
    const out = await investigate({} as any, { path: "/p", topic, note: null, signal: new AbortController().signal, timeoutMs: 20,
      flags: [{ flag: flag({ key: "agenda-1" }), index: 0 }] });
    expect(out[0].finding).toBeNull();
  });
});

describe("investigatedRecords", () => {
  it("reads each record a finding rests on once, in full, for the re-check", async () => {
    readRecord.mockImplementation(async (_s: unknown, ref: string) => ref === "section:5132" ? "MINUTES … That Council approve … CARRIED." : `No record ${ref}.`);
    const finding = (ref: string | null) => ({ verdict: "supported" as const, explanation: "", quote: null, ref });
    const text = await investigatedRecords({} as any, [
      { index: 0, key: "agenda-973", question: "", finding: finding("section:5132") },
      { index: 1, key: "agenda-974", question: "", finding: finding("section:5132") },
      { index: 2, key: null, question: "", finding: finding("motion:9") },
      { index: 3, key: null, question: "", finding: finding(null) },
    ]);
    expect(readRecord).toHaveBeenCalledTimes(2);
    expect(text).toBe("RECORD section:5132 (read by the fix agent):\nMINUTES … That Council approve … CARRIED.");
  });
});
