import { describe, expect, it, vi } from "vitest";
import { addressesBlock, foldAmended, mergeAddress, checkFollowed, decisionsBlock, editSourceOnPage, heldByHandLine, loadSources, quoteInRecords, rewriteDecision, saveEditorNotes, summaryInstruction, unfollowedLine, unlinkAddress,
  writeEntryText } from "../../app/services/fix-ops.server";

let verdicts: { followed: boolean; missing: string }[] = [];
vi.mock("../../app/services/ai/index.server", () => ({ getAiClient: () => ({ json: async () => ({ data: { checks: verdicts } }) }) }));

/** A small stand-in for the Supabase client: one row per table, every update recorded. */
function fake(tables: Record<string, any[]>) {
  const updates: { table: string; patch: any; id?: number }[] = [];
  const client: any = { from: (table: string) => ({
    select: () => ({
      eq: (_c: string, v: any) => ({ single: async () => ({ data: (tables[table] || []).find((r) => r.id === v) ?? null, error: null }) }),
      in: async (_c: string, vs: any[]) => ({ data: (tables[table] || []).filter((r) => vs.includes(r.id)), error: null }),
    }),
    update: (patch: any) => ({ eq: async (_c: string, id: number) => { updates.push({ table, patch, id }); return { error: null }; } }),
  }) };
  return { client, updates };
}
const source = { id: 12, origin: "press", publisher: "CHEK News", title: "t", url: "https://x.test", published_on: "2026-07-22", happened_on: "2026-07-22", headline: "Parks plan to sell 25 acres", quote: null } as any;
const step = (over: Record<string, any> = {}) => ({ key: "source-12", source: "the plan describes the property as 22 acres", source_id: 12, new_headline: "Parks plan recommends exploring a sale", new_quote: null, new_note: null, new_date_label: null, ...over });
const ctx = (over: Record<string, any> = {}) => ({ sources: [source], textOf: new Map([[12, "In the plan, the plan describes the property as 22 acres of oceanfront."]]), records: "", flagged: () => true, ...over });

describe("quoteInRecords", () => {
  it("matches the record's words whatever the spacing and quote marks, and ignores lines a model wrote", () => {
    expect(quoteInRecords("“Council   adopted the bylaw”", "Then \"Council adopted the bylaw\" was carried.")).toBe(true);
    expect(quoteInRecords("Council adopted the bylaw", "FOUND for matter-1: Council adopted the bylaw")).toBe(false);
    expect(quoteInRecords("short", "short")).toBe(false);
  });
});

describe("editSourceOnPage", () => {
  it("changes the source when the quote is in its own text, and says what changed", async () => {
    const { client, updates } = fake({ sources: [{ id: 12, meta: {} }] });
    const result = await editSourceOnPage(client, step(), ctx());
    expect(result).toMatchObject({ ok: true, edit: { headline: "Parks plan recommends exploring a sale" } });
    expect(updates).toEqual([{ table: "sources", patch: { headline: "Parks plan recommends exploring a sale" }, id: 12 }]);
  });
  it("refuses a source that isn't on the page, isn't flagged, or whose quote isn't the source's words", async () => {
    const { client, updates } = fake({ sources: [{ id: 12, meta: {} }] });
    expect(await editSourceOnPage(client, step({ source_id: 99 }), ctx())).toEqual({ ok: false, why: "no such source on this page" });
    expect(await editSourceOnPage(client, step(), ctx({ flagged: () => false }))).toMatchObject({ ok: false });
    expect(await editSourceOnPage(client, step({ source: "something the source never said at all" }), ctx())).toMatchObject({ ok: false, why: expect.stringContaining("exact words") });
    expect(await editSourceOnPage(client, step({ new_quote: "an invented quotation that isn't there" }), ctx())).toMatchObject({ ok: false, why: expect.stringContaining("new quote") });
    expect(await editSourceOnPage(client, step({ new_headline: null }), ctx())).toMatchObject({ ok: false, why: expect.stringContaining("didn't give") });
    expect(updates).toEqual([]);
  });
});

describe("loadSources", () => {
  it("dedupes sources and returns each one's saved text", async () => {
    const { client } = fake({ sources: [{ id: 12, content_text: "page text" }] });
    const loaded = await loadSources(client, [source, source]);
    expect(loaded.sources).toHaveLength(1);
    expect(loaded.textOf.get(12)).toBe("page text");
  });
});

describe("summary instructions", () => {
  it("joins the instruction and the record's words, and gives nothing for an empty one", () => {
    expect(summaryInstruction("  Say the plan only recommends a sale. ", "The plan recommends   exploring a sale")).toBe("Say the plan only recommends a sale. The record says: “The plan recommends exploring a sale”");
    expect(summaryInstruction("  ", "x")).toBeNull();
  });
  it("keeps the last ten notes on the topic", async () => {
    const { client, updates } = fake({ matters: [{ id: 5, meta: { editor_notes: Array.from({ length: 9 }, (_, i) => `old ${i}`), keep: true } }] });
    await saveEditorNotes(client, 5, ["a", "b"]);
    expect(updates[0].patch.meta.editor_notes).toEqual([...Array.from({ length: 8 }, (_, i) => `old ${i + 1}`), "a", "b"]);
    expect(updates[0].patch.meta.keep).toBe(true);
  });
  it("words an unfollowed instruction for the note", () => {
    expect(unfollowedLine({ note: "Say X. The record says: “y”", missing: "the date" })).toBe('The summary was rewritten but doesn\'t yet say what was asked: "Say X." Still missing: the date');
  });
});

describe("writeEntryText", () => {
  it("writes a step's line to both headline copies and a mention's line to entry_lines, keeping what's there", async () => {
    const { client, updates } = fake({ matters: [{ id: 5, meta: { timeline_headlines: { "1": "old" }, entry_lines: { "mention-2": { line: "was", source: "s" } } } }] });
    expect(await writeEntryText(client, 5, { headlines: { "7": "New step line" }, lines: { "mention-2": { line: "now" }, "report-3": { heading: "H" } } })).toBeNull();
    const meta = updates[0].patch.meta;
    expect(meta.timeline_headlines).toEqual({ "1": "old", "7": "New step line" });
    expect(meta.staff_headlines).toEqual({ "7": "New step line" });
    expect(meta.entry_lines).toEqual({ "mention-2": { line: "now", source: "s" }, "report-3": { heading: "H" } });
  });
  it("does nothing when there is nothing to write", async () => {
    const { client, updates } = fake({ matters: [{ id: 5, meta: {} }] });
    expect(await writeEntryText(client, 5, {})).toBeNull();
    expect(updates).toEqual([]);
  });
});

describe("checkFollowed", () => {
  it("returns one verdict per instruction, in order, with what is still missing", async () => {
    verdicts = [{ followed: false, missing: "It isn't in the order things happened." }, { followed: true, missing: "" }];
    const out = await checkFollowed(["Make it a timeline", "Name the cost"], "The City bought it. It spent $6M.", "records");
    expect(out).toEqual([
      { instruction: "Make it a timeline", followed: false, missing: "It isn't in the order things happened." },
      { instruction: "Name the cost", followed: true, missing: "" },
    ]);
  });
  it("treats an instruction the check didn't answer as not followed, and asks nothing when there are none", async () => {
    verdicts = [{ followed: true, missing: "" }];
    const out = await checkFollowed(["one", "two"], "text", "records");
    expect(out[1]).toMatchObject({ followed: false });
    expect(await checkFollowed([], "text", "records")).toEqual([]);
  });
});

describe("heldByHandLine", () => {
  it("says the text was edited by hand, that it was kept, and how to use the agent's version", () => {
    expect(heldByHandLine("this topic", ["summary"])).toBe("The summary of this topic wasn't changed: it was edited by hand, so that version was kept. The agent's version is saved as the automatic one; open the pencil and press Reset to automatic to use it.");
  });
  it("names the status line too, and says nothing about the title", () => {
    expect(heldByHandLine("the budget topic", ["title", "summary", "status_line"])).toContain('summary and "where it stands" line of the budget topic');
    expect(heldByHandLine("x", ["title", "summary"])).not.toContain("title");
  });
});

describe("rewriteDecision", () => {
  const records = "ITEM 10632 (2012-03-05): DVP11-0036 - 245 Atkins Avenue\n  MOTION: That Council issue Development Variance Permit No. DVP11-0036 - 245 Atkins Avenue | RESULT: CARRIED";
  const decision = () => ({ id: 6001, itemId: 10581, text: "Direct staff to proceed with consideration of the following variances for 245 Atkins Rd", summary: "Directed staff to consider a longer road at 245 Atkins Road." });
  const step = (over: Record<string, any> = {}) => ({ decision_id: 6001, new_text: "Directed staff to consider a longer road at 245 Atkins Avenue.", source: "Development Variance Permit No. DVP11-0036 - 245 Atkins Avenue", ...over });

  it("sets the plain line, marks it a person's and keeps the old line as auto", async () => {
    const { client, updates } = fake({ motions: [{ id: 6001, meta: { headline: "h" }, plain_english_summary: "Directed staff to consider a longer road at 245 Atkins Road." }] });
    const result = await rewriteDecision(client, step(), { decisions: [decision()], records, by: "u1" });
    expect(result).toMatchObject({ ok: true, text: "Directed staff to consider a longer road at 245 Atkins Avenue." });
    expect(updates[0].patch.plain_english_summary).toBe("Directed staff to consider a longer road at 245 Atkins Avenue.");
    expect(updates[0].patch.meta).toMatchObject({ headline: "h", manual: { summary: { by: "u1", auto: "Directed staff to consider a longer road at 245 Atkins Road." } } });
  });
  it("refuses a decision not on the page, an unusable line, or a quote that isn't in the records", async () => {
    const { client, updates } = fake({ motions: [{ id: 6001, meta: {} }] });
    const ctx = { decisions: [decision()], records, by: "u1" };
    expect(await rewriteDecision(client, step({ decision_id: 7 }), ctx)).toMatchObject({ ok: false });
    expect(await rewriteDecision(client, step({ new_text: "Short." }), ctx)).toMatchObject({ ok: false });
    expect(await rewriteDecision(client, step({ source: "Council refused the permit for 245 Atkins" }), ctx)).toMatchObject({ ok: false });
    expect(updates).toEqual([]);
  });
  it("lists decisions under the entry key the page uses, and skips ones not on it", () => {
    const block = decisionsBlock([decision(), { ...decision(), id: 9, itemId: 1 }], (id) => (id === 10581 ? "agenda-10581" : null));
    expect(block).toContain("decision-6001 under [agenda-10581]");
    expect(block).not.toContain("decision-9");
  });
});

describe("unlinkAddress", () => {
  const addresses = () => [{ id: 11274, address: "245 Atkins Avenue", slug: "245-atkins-avenue", civic_number: "245", itemIds: [10581, 10632] },
    { id: 12734, address: "245 Atkins Road", slug: "245-atkins-road", civic_number: "245", itemIds: [10581] }];
  const records = "ITEM 10632: DVP11-0036 - 245 Atkins Avenue";
  function linkFake() {
    const hidden: { property_id: number; matter_id: number }[] = [];
    const client: any = { from: () => ({ update: () => ({ eq: (_a: string, property_id: number) => ({ eq: async (_b: string, matter_id: number) => { hidden.push({ property_id, matter_id }); return { error: null }; } }) }) }) };
    return { client, hidden };
  }
  it("hides the address's links to this topic only", async () => {
    const { client, hidden } = linkFake();
    const list = addresses();
    const result = await unlinkAddress(client, 2757, { property_id: 12734, source: "DVP11-0036 - 245 Atkins Avenue" }, { addresses: list, records });
    expect(result).toMatchObject({ ok: true, address: { address: "245 Atkins Road" } });
    expect(hidden).toEqual([{ property_id: 12734, matter_id: 2757 }]);
    expect(list.map((a) => a.id)).toEqual([11274]);
  });
  it("keeps the topic's only address, an address not mapped to it, and one without a record quote", async () => {
    const { client, hidden } = linkFake();
    expect(await unlinkAddress(client, 2757, { property_id: 11274, source: "DVP11-0036 - 245 Atkins Avenue" }, { addresses: addresses().slice(0, 1), records })).toMatchObject({ ok: false });
    expect(await unlinkAddress(client, 2757, { property_id: 1, source: "DVP11-0036 - 245 Atkins Avenue" }, { addresses: addresses(), records })).toMatchObject({ ok: false });
    expect(await unlinkAddress(client, 2757, { property_id: 12734, source: "the street is Atkins Avenue" }, { addresses: addresses(), records })).toMatchObject({ ok: false });
    expect(hidden).toEqual([]);
    expect(addressesBlock(addresses())).toContain("address-12734: 245 Atkins Road (from item 10581)");
  });
});

describe("mergeAddress", () => {
  /** property_links, source_links and properties in memory, with the query shapes mergeAddress uses. */
  function db() {
    const t: Record<string, any[]> = {
      property_links: [{ id: 1, property_id: 2, agenda_item_id: 10581, matter_id: 2757 }, { id: 2, property_id: 2, agenda_item_id: 99, matter_id: null },
        { id: 3, property_id: 1, agenda_item_id: 10581, matter_id: 2757 }],
      source_links: [], properties: [{ id: 1, meta: {} }, { id: 2, meta: {} }, { id: 3, meta: { merged_into: 2 } }],
    };
    const where = (rows: any[], f: (r: any) => boolean) => rows.filter(f);
    const client: any = { from: (table: string) => {
      const rows = t[table];
      const q = (f: (r: any) => boolean) => ({
        eq: (c: string, v: any) => q((r) => f(r) && r[c] === v),
        in: (c: string, vs: any[]) => q((r) => f(r) && vs.includes(r[c])),
        contains: (_c: string, v: any) => q((r) => f(r) && r.meta?.merged_into === v.merged_into),
        single: async () => ({ data: where(rows, f)[0] ?? null }),
        then: (ok: any) => Promise.resolve({ data: where(rows, f), error: null }).then(ok),
      });
      return {
        select: () => q(() => true),
        update: (patch: any) => ({ in: async (c: string, vs: any[]) => { for (const r of rows) if (vs.includes(r[c])) Object.assign(r, patch); return { error: null }; },
          eq: async (c: string, v: any) => { for (const r of rows) if (r[c] === v) Object.assign(r, patch); return { error: null }; } }),
        delete: () => ({ in: async (c: string, vs: any[]) => { t[table] = rows.filter((r) => !vs.includes(r[c])); return { error: null }; } }),
      };
    } };
    return { client, t };
  }
  const road = { id: 2, address: "245 Atkins Road", slug: "245-atkins-road", civic_number: "245" };
  const avenue = { id: 1, address: "245 Atkins Avenue", slug: "245-atkins-avenue", civic_number: "245" };

  it("moves the links the right spelling lacks, drops the ones it has, and leaves a hidden alias", async () => {
    const { client, t } = db();
    expect(await mergeAddress(client, road, avenue, "u1")).toBeNull();
    expect(t.property_links.map((l) => [l.id, l.property_id])).toEqual([[2, 1], [3, 1]]);
    expect(t.properties.find((p) => p.id === 2)).toMatchObject({ hidden: true, meta: { merged_into: 1 } });
    expect(t.properties.find((p) => p.id === 3)!.meta.merged_into).toBe(1);
  });
  it("refuses different civic numbers", async () => {
    const { client } = db();
    expect(await mergeAddress(client, road, { ...avenue, civic_number: "247" }, "u1")).toMatch(/different lots/);
  });
});

describe("foldAmended", () => {
  const minutes = "Motion CARRIED. **On the Main Motion as Amended:** THAT the Sustainable Development Advisory Committee recommend";
  const decisions = () => [{ id: 9504, itemId: 13033, text: "THAT the committee recommend… iv.", summary: "Recommended renewal." },
    { id: 9508, itemId: 13033, text: "THAT the committee recommend… vii.", summary: "Recommended renewal." }, { id: 1, itemId: 5, text: "x", summary: null }];
  it("marks the original wording as replaced by the motion as amended", async () => {
    const { client, updates } = fake({ motions: [{ id: 9504, meta: { headline: "h" } }] });
    const result = await foldAmended(client, { decision_id: 9504, amended_decision_id: 9508, source: "On the Main Motion as Amended" }, { decisions: decisions(), records: minutes, by: "u1" });
    expect(result).toMatchObject({ ok: true });
    expect(updates[0]).toMatchObject({ id: 9504, patch: { meta: { headline: "h", amended_by: 9508, amended_note: { by: "u1" } } } });
  });
  it("refuses decisions under different entries, or a quote that doesn't show an amendment", async () => {
    const { client, updates } = fake({ motions: [] });
    expect(await foldAmended(client, { decision_id: 9504, amended_decision_id: 1, source: "On the Main Motion as Amended" }, { decisions: decisions(), records: minutes, by: "u1" })).toMatchObject({ ok: false });
    expect(await foldAmended(client, { decision_id: 9504, amended_decision_id: 9508, source: "the Sustainable Development Advisory Committee recommend" }, { decisions: decisions(), records: minutes, by: "u1" })).toMatchObject({ ok: false });
    expect(updates).toEqual([]);
  });
});
