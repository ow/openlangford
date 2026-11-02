import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { expect, it, vi } from "vitest";
// Account UI is outside this public chronology contract.
vi.mock("../../app/components/subscribe-button", () => ({ SubscribeButton: () => null }));
import MatterDetail from "../../app/routes/matter-detail";

it("labels earlier background with its owner while preserving the proceeding's own dates and deduplicating its items", () => {
  const proposal = { id: 208, slug: "parks-rates", title: "Parks rate proposal" };
  const current = { id: 6716, meeting_id: 394, title: "First reading", meetings: { slug: "2026-07-20-regular-council", meeting_date: "2026-07-20" }, motions: [] };
  const background = { id: 1369, meeting_id: 50, title: "Proposed Parks DCC Rates", plain_english_summary: "Consultant presented draft rates.", meetings: { slug: "2026-06-29-special-council", meeting_date: "2026-06-29" }, relatedMatter: proposal };
  const html = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(MatterDetail, { loaderData: {
    matter: { id: 1685, title: "Parks charges bylaw", slug: "parks-charges", status: "Active", agenda_items: [current], meta: {} },
    matterDocuments: [], matterEvidence: [], story: { related: [proposal], mentions: [], background: [background, { ...current, relatedMatter: proposal }] }, images: { lead: null, layout: null },
  } } as any)));
  const text = html.replace(/<[^>]*>/g, "");
  expect(text).toContain("Part of Parks rate proposal");
  expect(text).toContain("June 29, 2026");
  expect(text).toContain("Discussed Jul 20, 2026");
  expect(text).not.toContain("Discussed Jun 29");
  expect((text.match(/Part of Parks rate proposal/g) || [])).toHaveLength(1);
  expect(html).toContain('href="/matters/parks-rates"');
});
