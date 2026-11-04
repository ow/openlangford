import { beforeEach, describe, expect, it, vi } from "vitest";

const json = vi.fn();
vi.mock("../../app/services/ai/index.server", () => ({ getAiClient: () => ({ json }) }));
vi.mock("../../app/services/page-verify.server", () => ({
  verifyAgainstRecords: vi.fn(async () => []),
  topicItemIds: vi.fn(async (_s: unknown, id: number) => [id * 10]),
  itemRecords: vi.fn(async (_s: unknown, ids: number[]) => ({ text: `records of item ${ids[0]}`, covered: new Set(ids) })),
}));

const { checkRelatedTopics, readPage } = await import("../../app/services/page-check.server");

const html = `<main><h1>Easement at 3037 Shoreview Drive</h1>
<section><h2>Related topics</h2><ol>
<li data-review-entry="related-819"><a><p>Aug 20, 2018</p><p>3037 Shoreview Drive park access</p></a></li>
<li data-review-entry="related-900"><a><p>2020</p><p>Goldstream sewer</p></a></li>
</ol></section>
<section><h2>Timeline</h2><ol><li id="timeline-agenda-9913"><p>Parks staff report on Shoreview Drive easement</p></li></ol></section>
</main>`;

describe("related topics on a topic page", () => {
  beforeEach(() => json.mockReset());

  it("reads each Related topics card as an entry that ends with its own card", () => {
    const page = readPage(html);
    expect(page.entries.map((e) => e.key)).toEqual(["related-819", "related-900", "agenda-9913"]);
    expect(page.entries[1].text).toBe("2020 · Goldstream sewer");
  });

  it("judges them from both topics' records and flags only the ones that don't belong", async () => {
    json.mockResolvedValue({ model: "m", data: { topics: [
      { key: "related-819", verdict: "same_project", reason: "The 2018 item renewed the 2013 access agreement." },
      { key: "related-900", verdict: "different", reason: "A sewer project elsewhere." },
      { key: "related-1", verdict: "different", reason: "Not on the page." },
    ] } });
    const flags = await checkRelatedTopics({} as any, 2524, readPage(html).entries);
    const prompt = json.mock.calls[0][0].prompt as string;
    expect(prompt).toContain("records of item 25240");  // this topic's own records
    expect(prompt).toContain("[related-819] as listed: Aug 20, 2018 · 3037 Shoreview Drive park access\nIts records:\nrecords of item 8190");
    expect(prompt).not.toContain("agenda-9913");
    expect(flags).toEqual([
      expect.objectContaining({ key: "related-819", problem: "duplicate", fix: "Merge this topic with the page's topic", verdict: null }),
      expect.objectContaining({ key: "related-900", problem: "different_story", fix: "Take this topic off Related topics" }),
    ]);
  });

  it("does nothing on a page without related topics", async () => {
    expect(await checkRelatedTopics({} as any, 1, [{ key: "agenda-1", text: "x" }])).toEqual([]);
    expect(json).not.toHaveBeenCalled();
  });
});
