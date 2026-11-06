import { describe, expect, it } from "vitest";
import { checkPayload, editInstructions, readVerdict } from "../topic-summaries.server";

const update = (summary = "S", status = "St") => ({ plain_english_summary: summary, meta: { status_line: status, timeline_headlines: { "1": "H" }, staff_headlines: {} } });
const topic: any = { id: 7, title: "T", identifier: null, history: [], mentions: [], _has_mentions: false, _owned_item_ids: new Set(), _meta: {} };

describe("combined summary check", () => {
  it("numbers each instruction and leaves the key out when there are none", () => {
    const withNotes = checkPayload([topic], new Map([[7, update()]]), new Map([[7, ["Say it passed", "Drop the date"]]]));
    expect(withNotes[0].editor_instructions).toEqual([{ n: 0, text: "Say it passed" }, { n: 1, text: "Drop the date" }]);
    expect(checkPayload([topic], new Map([[7, update()]]))[0]).not.toHaveProperty("editor_instructions");
  });

  it("reads problems per topic and the instructions that aren't followed", () => {
    const notes = new Map([[7, ["a", "b", "c"]]]);
    const v = readVerdict({
      problems: [{ matter: 7, statement: "x", verdict: "contradicted", record_says: "y" }, { matter: 99, statement: "z", verdict: "not_in_record", record_says: "" }],
      notes: [{ matter: 7, n: 0, followed: true, missing: "" }, { matter: 7, n: 1, followed: false, missing: "the date" }],
    }, new Map([[7, update()]]), notes);
    expect(v.problems.get(7)).toEqual([{ statement: "x", verdict: "contradicted", record_says: "y" }]);
    expect(v.problems.has(99)).toBe(false);
    // n=1 said not followed; n=2 was never answered, so it can't be claimed.
    expect(v.unfollowed).toEqual([{ note: "b", matter_id: 7, missing: "the date" }, { note: "c", matter_id: 7, missing: "" }]);
  });

  it("builds direct-edit instructions from unfollowed notes and fact problems", () => {
    const out = editInstructions(["Say it passed"], [
      { statement: "$5M", verdict: "contradicted", record_says: "$4M" }, { statement: "40 homes", verdict: "not_in_record", record_says: "" }]);
    expect(out[0]).toBe("Say it passed");
    expect(out[1]).toContain("records contradict it: \"$5M\"");
    expect(out[1]).toContain("“$4M”");
    expect(out[2]).toContain("don't contain it: \"40 homes\"");
  });
});
