import { describe, expect, it } from "vitest";
import { editSourceOnPage, loadSources, quoteInRecords, saveEditorNotes, summaryInstruction, unfollowedLine, writeEntryText } from "../../app/services/fix-ops.server";

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
