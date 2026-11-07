import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PageFlag } from "../../app/lib/page-review-types";

const judgeTopics = vi.fn();
vi.mock("../../app/services/page-check.server", () => ({ judgeTopics, readPage: vi.fn() }));

const { settleHeldElsewhere, planPrompt } = await import("../../app/services/page-fix.server");

const supabase = {
  from: () => ({ select: () => ({ in: async () => ({ data: [{ id: 1091, title: "Public Hearing Policy Amendments",
    meta: { display_title: "Public hearing and notification procedures" } }] }) }) }),
} as any;
const held = [{ key: "mention-3423", owner: 1091, reason: "Council directed staff to amend the public hearing policy, a step in its history." }];
const outcome = () => ({ answered: [] as string[], answeredKeys: new Set<string | null>(), left: [] as string[] });

describe("filing here an item another topic holds", () => {
  beforeEach(() => judgeTopics.mockReset());

  it("merges that topic in when both topics' records show one project", async () => {
    judgeTopics.mockResolvedValue([{ key: "related-1091", verdict: "same_project", reason: "Its 2024 item amends the 2020 policy." }]);
    const merges: any[] = [];
    const out = outcome();
    await settleHeldElsewhere(supabase, 410, held, merges, undefined, out);
    const [, matterId, others, options] = judgeTopics.mock.calls[0];
    expect(matterId).toBe(410);
    expect(others).toEqual([expect.objectContaining({ key: "related-1091", text: expect.stringContaining("Public hearing and notification procedures") })]);
    expect(options.shown).toContain("filed on the other topics below");
    expect(merges).toEqual([{ with_matter_id: 1091, key: "mention-3423",
      reason: expect.stringContaining("Merged \"Public hearing and notification procedures\" into this page: it is the same project. Its 2024 item amends the 2020 policy.") }]);
    expect(out.left).toEqual([]);
  });

  it("keeps the entry as a mention and answers the flag when they are separate", async () => {
    judgeTopics.mockResolvedValue([{ key: "related-1091", verdict: "belongs", reason: "It sets notice rules for all hearings, a separate policy." }]);
    const merges: any[] = [];
    const out = outcome();
    await settleHeldElsewhere(supabase, 410, held, merges, undefined, out);
    expect(merges).toEqual([]);
    expect(out.answered[0]).toContain("It stays a mention here: it is filed on \"Public hearing and notification procedures\", a separate topic. It sets notice rules");
    expect(out.answeredKeys.has("mention-3423")).toBe(true);
  });

  it("changes nothing, and says so, when the comparison fails", async () => {
    judgeTopics.mockRejectedValueOnce(new Error("timeout"));
    const merges: any[] = [];
    const out = outcome();
    await settleHeldElsewhere(supabase, 410, held, merges, undefined, out);
    expect(merges).toEqual([]);
    expect(out.left[0]).toContain("comparing the two topics' records didn't finish");
  });

  it("needs no comparison when the plan already merges that topic", async () => {
    const merges: any[] = [{ with_matter_id: 1091, reason: "Same policy.", key: null }];
    await settleHeldElsewhere(supabase, 410, held, merges, undefined, outcome());
    expect(judgeTopics).not.toHaveBeenCalled();
    expect(merges).toEqual([{ with_matter_id: 1091, reason: "Same policy.", key: "mention-3423" }]);
  });
});

describe("the plan prompt", () => {
  const flags: PageFlag[] = [
    { key: "agenda-973", problem: "generic_text", reason: "Doesn't say what was decided.", excerpt: "Staff present public hearing policy", verdict: "agree" },
    { key: "mention-11059", problem: "unclear_why", reason: "Unclear connection.", excerpt: "2012 waiving criteria", verdict: "agree" },
  ];
  const prompt = planPrompt("Public hearing policy", [{ key: "agenda-973", text: "x" }, { key: "mention-11059", text: "y" }], flags, null,
    new Map(), "ITEM 973 …", [{ id: 1091, title: "Public hearing and notification procedures", dates: "2024-03-04", owner: true }], [], null, "",
    ["supported. Council approved the policy. The record says: “That Council approve Council Policy POL-0155-ADMIN … CARRIED.” (section:5132)", undefined]);

  it("puts what the agent found beside its flag", () => {
    expect(prompt).toContain("Doesn't say what was decided.\n  What you found in the City's records: supported. Council approved the policy.");
    expect(prompt).toContain("Unclear connection.\n");
    expect(prompt).not.toContain("Unclear connection.\n  What you found");
  });

  it("offers a topic holding an accepted entry with its records", () => {
    expect(prompt).toContain('1091 "Public hearing and notification procedures" (2024-03-04) [holds an entry staff accepted for this page; its records are below]');
  });

  it("has the rules on silence, explaining before removing, and naming the record a cannot_fix needs", () => {
    expect(prompt).toContain("only when\n  that meeting's minutes are in your records");
    expect(prompt).toContain("Explain before removing");
    expect(prompt).toContain("A cannot_fix names the record it needs");
    expect(prompt).toContain("give file_here all the same");
  });
});

describe("planPrompt: a fix that didn't hold", () => {
  it("tells the agent why its earlier fix failed the re-check", () => {
    const flags: PageFlag[] = [{ key: "agenda-10608", problem: "unsupported", reason: "Contradicted by the record", excerpt: "x", verdict: "agree",
      fixed: false, recheck: { holds: false, checked: true, at: "2026-11-07T18:29:56Z", reason: "The motion required the report after final grading was determined." } }];
    const prompt = planPrompt("Walfred Road", [{ key: "agenda-10608", text: "x" }], flags, null, new Map(), "");
    expect(prompt).toContain("An earlier fix didn't hold when checked against the records: The motion required the report after final grading was determined.");
  });
});
