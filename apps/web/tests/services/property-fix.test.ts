import { describe, expect, it } from "vitest";
import { propertyPlanPrompt, propertyRecords, withClosing } from "../../app/services/property-fix.server";
import { updateSource } from "../../app/services/sources.server";

const property = { id: 771, slug: "3094-jacklin-road", address: "3094 Jacklin Road", civic_number: "3094", street: "Jacklin Road", meta: {} };

describe("withClosing", () => {
  it("keeps the pipeline's closing count line from the old lead", () => {
    const old = "A duplex was approved here in 2019. Mentioned in council meetings 5 times since 2012.";
    expect(withClosing(old, "A six-storey building with 76 rental apartments was approved for this lot in 2026.  "))
      .toBe("A six-storey building with 76 rental apartments was approved for this lot in 2026. Mentioned in council meetings 5 times since 2012.");
  });
  it("adds nothing when the old lead had no closing line, and doesn't double one the agent wrote", () => {
    expect(withClosing(null, "New text.")).toBe("New text.");
    expect(withClosing("Old. Mentioned in council meetings twice in 2012.", "New text. Mentioned in council meetings twice in 2012.")).toBe("New text. Mentioned in council meetings twice in 2012.");
  });
});

describe("the planner's records and prompt", () => {
  it("keys each entry the way the page does and lists the other addresses a topic covers", () => {
    const records = propertyRecords(property as any, null, [
      { id: 506, title: "Jacklin Road rezoning", status: "Adopted", first_seen: "2026-04-13", last_seen: "2026-08-17", plain_english_summary: "A six-storey building with 76 rental apartments.", meta: { status_line: "Rezoning made final Aug 17, 2026." }, addresses: ["3084 Jacklin Road", "3088 Jacklin Road"] },
    ], [{ id: 13217, title: "Application to Rezone 3084, 3088, 3094/3096 Jacklin Road", plain_english_summary: null, meeting_date: "2026-04-13", meeting_title: "Regular Council" }]);
    expect(records).toContain("TOPIC matter-506");
    expect(records).toContain("ITEM item-13217");
    expect(records).toContain("3084 Jacklin Road; 3088 Jacklin Road");
    expect(records).toContain("LEAD (the page's own text): (none yet)");
    const prompt = propertyPlanPrompt(property as any, [{ key: "matter-506", problem: "different_story", reason: "About another lot.", excerpt: "", verdict: "agree" } as any], null, records, [null], null);
    expect(prompt).toContain("matter-506 ·");
    expect(prompt).toContain("unlink_entry");
    expect(prompt).toContain("rewrite_lead");
  });
});

describe("what the planner can see and do beyond unlinking", () => {
  const topic = { id: 1825, title: "Parks committee", status: "Open", first_seen: "2020-09-24", last_seen: "2020-09-24", plain_english_summary: null, meta: {}, addresses: [] };
  const step = { id: 7428, matter_id: 1825, title: "Capital project update", meeting_date: "2020-09-24", meeting_title: "Parks Committee", line: "Committee discussed the waterfront" };
  const source = { id: 12, origin: "press", publisher: "CHEK News", title: "t", url: "https://example.com", published_on: "2019-11-02", happened_on: "2019-05-07", headline: "City buys 25 acres", quote: null } as any;

  it("lists each topic's steps with what the page shows now, and the sources by their page key", () => {
    const records = propertyRecords(property as any, null, [topic], [], [step], [source]);
    expect(records).toContain("STEP step-7428 (2020-09-24, Parks Committee): Capital project update | the page now shows: Committee discussed the waterfront");
    expect(records).toContain("source-<id>");
    expect(records).toContain("SOURCE source:12");
  });
  it("lists annual report rows by the key the page uses", () => {
    const records = propertyRecords(property as any, null, [topic], [], [], [], [{ id: 31, matter_id: 1825, year: 2019, title: "t", page: 14, quote: "Purchased 3680 Trans-Canada Highway", url: null }]);
    expect(records).toContain("REPORT report-31 (2019 annual report, page 14): Purchased 3680 Trans-Canada Highway");
  });
  it("omits the step and source blocks when there are none", () => {
    const records = propertyRecords(property as any, null, [topic], []);
    expect(records).not.toContain("STEP");
    expect(records).not.toContain("SOURCE");
  });
  it("offers the new actions and tells the planner when an entry counts as passing", () => {
    const prompt = propertyPlanPrompt(property as any, [], null, "", [], null);
    for (const a of ["edit_source", "rewrite_entry", "rewrite_summary", "one of them"]) expect(prompt).toContain(a);
  });
});

describe("updateSource", () => {
  function fake(meta: Record<string, any> | null = { date_label: "Spring 2019", compact: true }) {
    const calls: any[] = [];
    const client: any = { from: () => ({
      select: () => ({ eq: () => ({ single: async () => ({ data: { meta }, error: null }) }) }),
      update: (patch: any) => { calls.push(patch); return { eq: async () => ({ error: null }) }; },
    }) };
    return { client, calls };
  }
  it("changes only the fields given and keeps the rest of meta", async () => {
    const { client, calls } = fake();
    await updateSource(client, 12, { headline: "  City buys land  ", date_label: "Summer 2019" });
    expect(calls).toEqual([{ headline: "City buys land", meta: { date_label: "Summer 2019", compact: true } }]);
  });
  it("clears a note or a date label when given empty, and refuses an empty headline", async () => {
    const { client, calls } = fake();
    await updateSource(client, 12, { note: "", date_label: "" });
    expect(calls).toEqual([{ note: null, meta: { compact: true } }]);
    await expect(updateSource(client, 12, { headline: "  " })).rejects.toThrow(/headline/);
  });
  it("does nothing when nothing changes", async () => {
    const { client, calls } = fake();
    await updateSource(client, 12, {});
    expect(calls).toEqual([]);
  });
});
