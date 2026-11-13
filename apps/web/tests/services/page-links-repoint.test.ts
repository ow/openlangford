import { describe, expect, it } from "vitest";
import { headingChildren, isHeadingOrder, repointMention } from "../../app/services/page-links.server";

/** agenda_items and matter_links in memory, with the query shapes the heading helpers use. */
function db(links: any[]) {
  const t: Record<string, any[]> = {
    agenda_items: [{ id: 338, meeting_id: 38, item_order: "5.", title: "5. PRESENTATIONS", matter_id: null },
      { id: 339, meeting_id: 38, item_order: "5.1", title: "5.1 Presentation of Proposed 2024-2028 Five Year Financial Plan", matter_id: 1092 },
      { id: 340, meeting_id: 38, item_order: "6.1", title: "6.1 Other", matter_id: null }],
    matter_links: links,
  };
  const q = (rows: () => any[], f: (r: any) => boolean): any => ({
    eq: (c: string, v: any) => q(rows, (r) => f(r) && r[c] === v),
    like: (c: string, p: string) => q(rows, (r) => f(r) && String(r[c]).startsWith(p.replace(/%$/, ""))),
    order: () => q(rows, f),
    select: () => q(rows, f),
    maybeSingle: async () => ({ data: rows().filter(f)[0] ?? null }),
    then: (ok: any) => Promise.resolve({ data: rows().filter(f), error: null }).then(ok),
  });
  const client: any = { from: (table: string) => ({
    select: () => q(() => t[table], () => true),
    update: (patch: any) => {
      const u = (f: (r: any) => boolean): any => ({
        eq: (c: string, v: any) => u((r) => f(r) && r[c] === v),
        select: async () => { const hit = t[table].filter(f); hit.forEach((r) => Object.assign(r, patch)); return { data: hit, error: null }; },
      });
      return u(() => true);
    },
  }) };
  return { client, t };
}

describe("re-pointing a mention of an agenda heading", () => {
  it("knows a heading by its bare number and finds the items under it", async () => {
    expect([isHeadingOrder("5."), isHeadingOrder("5"), isHeadingOrder("5.1")]).toEqual([true, true, false]);
    const { client } = db([]);
    expect((await headingChildren(client, 338)).map((c) => c.id)).toEqual([339]);
  });
  it("points the mention at the item under the heading", async () => {
    const { client, t } = db([{ id: 1, matter_id: 1209, agenda_item_id: 338, kind: "mention", hidden: false }]);
    expect(await repointMention(client, 1209, 338, 339, "u1")).toMatch(/now links 5.1/);
    expect(t.matter_links[0]).toMatchObject({ agenda_item_id: 339, review: "accepted" });
  });
  it("takes the heading's entry off when the topic already shows the item, and refuses items not under the heading", async () => {
    const { client, t } = db([{ id: 1, matter_id: 1209, agenda_item_id: 338, kind: "mention", hidden: false },
      { id: 2, matter_id: 1209, agenda_item_id: 339, kind: "mention", hidden: false }]);
    await expect(repointMention(client, 1209, 338, 340, "u1")).rejects.toThrow(/isn't under the heading/);
    expect(await repointMention(client, 1209, 338, 339, "u1")).toMatch(/already shows/);
    expect(t.matter_links[0]).toMatchObject({ agenda_item_id: 338, hidden: true });
  });
});
