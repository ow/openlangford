import { describe, expect, it } from "vitest";
import { itemRecords } from "../../app/services/page-verify.server";

/** A read-only fake of the Supabase query builder over in-memory tables: select, in, eq, is, order and range, enough
 * for itemRecords. Embedded selects (meetings(meeting_date)) are stored on the rows as given. */
function fakeSupabase(tables: Record<string, Record<string, unknown>[]>) {
  return {
    from(table: string) {
      let rows = [...(tables[table] || [])];
      let from = 0, to = Infinity;
      const q: any = {
        select: () => q,
        in: (col: string, vals: unknown[]) => { rows = rows.filter((r) => vals.includes(r[col])); return q; },
        eq: (col: string, val: unknown) => { rows = rows.filter((r) => r[col] === val); return q; },
        is: (col: string, val: unknown) => { rows = rows.filter((r) => (r[col] ?? null) === val); return q; },
        order: () => q,
        range: (a: number, b: number) => { from = a; to = b; return q; },
        then: (resolve: (v: unknown) => void) => resolve({ data: rows.slice(from, to + 1), error: null }),
      };
      return q;
    },
  } as any;
}

// Jan 20, 2020: the Public Hearing Policy item has its staff report attached but no motion; the decision is only in
// the meeting's minutes, which the import left unattached.
const minutes = `6. REPORTS a) Public Hearing Policy - Staff Report (Administration) MOVED BY: COUNCILLOR BLACKWELL
That Council approve Council Policy POL-0155-ADMIN, the Public Hearing Policy. CARRIED.`;
const tables = {
  agenda_items: [
    { id: 973, meeting_id: 73, title: "Public Hearing Policy - Staff Report (Administration)", meetings: { meeting_date: "2020-01-20" } },
    { id: 974, meeting_id: 73, title: "West Shore Parks and Recreation Society 2020 Budget - Staff Report (Finance)", meetings: { meeting_date: "2020-01-20" } },
  ],
  motions: [{ id: 1, agenda_item_id: 974, text_content: "That Council receive the 2020 budget.", result: "CARRIED", votes: [] }],
  extracted_documents: [{ agenda_item_id: 973, title: "Staff Report: Public Hearing Policy", key_facts: ["Sets rules for public hearings"] }],
  document_sections: [
    { id: 5155, document_id: 227, agenda_item_id: 973, section_title: "Staff Report: Public Hearing Policy", section_text: "Staff recommend the policy.", section_order: 1 },
    { id: 5132, document_id: 228, agenda_item_id: null, section_title: "MINUTES", section_text: minutes, section_order: 1 },
    { id: 5133, document_id: 228, agenda_item_id: null, section_title: "MINUTES", section_text: "b) West Shore Parks and Recreation Society 2020 Budget: received.", section_order: 2 },
  ],
  documents: [{ id: 227, meeting_id: 73 }, { id: 228, meeting_id: 73 }],
};

describe("itemRecords and the meeting's minutes", () => {
  it("gives an item with a report but no motion the minutes paragraph that names its subject", async () => {
    const { text, covered } = await itemRecords(fakeSupabase(tables), [973]);
    expect(text).toContain("DOCUMENT TEXT: Staff Report: Public Hearing Policy: Staff recommend the policy.");
    expect(text).toContain("MINUTES OR REPORT TEXT FROM THIS MEETING: 6. REPORTS a) Public Hearing Policy");
    expect(text).toContain("That Council approve Council Policy POL-0155-ADMIN, the Public Hearing Policy. CARRIED.");
    expect(covered.has(973)).toBe(true);
  });

  it("doesn't add minutes to an item whose motion is recorded", async () => {
    const { text } = await itemRecords(fakeSupabase(tables), [974]);
    expect(text).toContain("MOTION: That Council receive the 2020 budget.");
    expect(text).not.toContain("MINUTES OR REPORT TEXT");
  });

  it("gives a section that names two items in full once, and points back to it", async () => {
    const both = { ...tables, agenda_items: [...tables.agenda_items,
      { id: 975, meeting_id: 73, title: "Public Hearing Policy - Presentation", meetings: { meeting_date: "2020-01-20" } }] };
    const { text } = await itemRecords(fakeSupabase(both), [973, 975]);
    expect(text.match(/That Council approve Council Policy/g)).toHaveLength(1);
    expect(text).toContain("MINUTES OR REPORT TEXT FROM THIS MEETING: the same text as given under ITEM 973.");
  });
});
