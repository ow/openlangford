import { createElement as h, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { Disc, FADED_CARD, RailItem, YearTimeline, groupByYear } from "../../app/components/timeline/chrome";
import { EntryRow } from "../../app/components/timeline/entry-rows";
import { TimelineStep } from "../../app/components/matter/timeline-step";
import { outcomeOf } from "../../app/lib/timeline-story";
import { sourceTimelineEntry, type Source } from "../../app/lib/sources";
import type { TimelineEntry } from "../../app/lib/timeline-entry";

const html = (el: ReactElement) => renderToStaticMarkup(h(MemoryRouter, null, el));
const entry = (over: Partial<TimelineEntry> = {}): TimelineEntry => ({ key: "source-1", date: "2026-08-26", kind: "source", label: "Reported by CHEK News", headline: "The City bought the land", ...over });

describe("groupByYear", () => {
  it("groups rows under their year in the order given, and puts a row with no date under Undated", () => {
    const rows = [{ d: "2026-02-01" }, { d: "2026-01-01" }, { d: "2024-05-05" }, { d: "" }, { d: "2026-03-03" }];
    expect(groupByYear(rows, (r) => r.d).map(([year, list]) => [year, list.length])).toEqual([["2026", 3], ["2024", 1], ["Undated", 1]]);
  });
});

describe("YearTimeline", () => {
  type Row = { id: string; d: string };
  const out = renderToStaticMarkup(YearTimeline<Row>({
    rows: [{ id: "a", d: "2026-01-01" }, { id: "b", d: "2025-01-01" }],
    dateOf: (r) => r.d,
    children: (r) => h("li", { key: r.id, id: `timeline-${r.id}` }, r.id),
  }));

  it("draws one rail, a heading per year and a list per year", () => {
    expect(out).toContain('<section aria-label="2026"');
    expect(out).toContain('<section aria-label="2025"');
    expect(out.match(/<h3[^>]*>20\d\d<\/h3>/g)).toHaveLength(2);
    expect(out.match(/<ol /g)).toHaveLength(2);
    expect(out).toContain('aria-hidden="true"');
  });
  it("closes each year with the pair the page check cuts a row at", () => {
    expect(out.match(/<\/ol><\/section>/g)).toHaveLength(2);
  });
});

describe("the dot and the row", () => {
  it("colours the dot by how the decision went, and leaves it hollow when nothing was decided", () => {
    expect(renderToStaticMarkup(h(Disc, { outcome: { label: "Passed", variant: "success" } }))).toContain("bg-emerald-600");
    expect(renderToStaticMarkup(h(Disc, { outcome: { label: "Defeated", variant: "danger" } }))).toContain("bg-red-600");
    expect(renderToStaticMarkup(h(Disc, { outcome: { label: "Postponed", variant: "warning" } }))).toContain("bg-amber-500");
    expect(renderToStaticMarkup(h(Disc, { decided: true }))).toContain("bg-brand-600");
    expect(renderToStaticMarkup(h(Disc, {}))).toContain("bg-surface");
  });
  it("anchors a row as timeline-<key> and marks it for the review bar only when asked", () => {
    expect(renderToStaticMarkup(h(RailItem, { id: "source-9", children: "x" }))).toMatch(/<li id="timeline-source-9"[^>]*>x<\/li>/);
    expect(renderToStaticMarkup(h(RailItem, { id: "item-3", reviewKey: "item-3", children: "x" }))).toContain('data-review-entry="item-3"');
    expect(renderToStaticMarkup(h(RailItem, { id: "item-3", children: "x" }))).not.toContain("data-review-entry");
  });
});

describe("EntryRow", () => {
  it("draws a source as a faded card with who said it, a pull quote and a link pill with its archived copy", () => {
    const out = html(h(EntryRow, { entry: entry({ detail: "The site should not be developed.", href: "https://example.test/a", external: true, linkTitle: "CHEK News", archiveHref: "https://web.archive.org/a" }) }));
    expect(out).toContain('id="timeline-source-1"');
    expect(out).toContain(FADED_CARD.split(" ")[0]);
    expect(out).toContain("Aug 26, 2026");
    expect(out).toContain("Reported by CHEK News");
    expect(out).toContain("<blockquote");
    expect(out).toContain("CHEK News</span>");
    expect(out).toContain("Archived copy");
  });

  it("shows an approximate date in place of the day", () => {
    expect(html(h(EntryRow, { entry: entry({ dateLabel: "Spring 2019" }) }))).toContain("Spring 2019");
  });

  it("draws thin context as one line with no card", () => {
    const out = html(h(EntryRow, { entry: entry({ compact: true, detail: "ignored in a one-liner", href: "https://example.test/n", external: true, linkTitle: "City of Langford" }) }));
    expect(out).toContain("Aug 26, 2026");
    expect(out).toContain("City of Langford");
    expect(out).not.toContain("rounded-2xl");
    expect(out).not.toContain("<blockquote");
    expect(out).not.toContain("ignored in a one-liner");
  });

  it("links a picture that previews a PDF to the PDF, marks it, and uses the source's own caption", () => {
    const out = html(h(EntryRow, { entry: entry({ images: [{ url: "https://cdn.test/p.jpg", href: "https://cdn.test/p.pdf", pdf: true, w: 10, h: 20, alt: "The table", caption: "As released. Click to open." }] }) }));
    expect(out).toContain('href="https://cdn.test/p.pdf"');
    expect(out).toContain('src="https://cdn.test/p.jpg"');
    expect(out).toContain(">PDF<");
    expect(out).toContain("As released. Click to open.");
    expect(out).toContain("bg-black/75");  // not a colour dark mode flips
  });

  it("embeds a video", () => {
    expect(html(h(EntryRow, { entry: entry({ video: { id: "dQw4w9WgXcQ", title: "A video" } }) }))).toContain("youtube-nocookie.com/embed/dQw4w9WgXcQ");
  });

  it("draws a report page's words as a quote, or staff's line as plain text under their heading", () => {
    const quoted = html(h(EntryRow, { entry: entry({ key: "report-5", kind: "report", label: "City annual report", dateLabel: "2019", headline: "Purchased the property" }) }));
    expect(quoted).toContain("<blockquote");
    expect(quoted).toContain(">2019</span> · City annual report");
    const line = html(h(EntryRow, { entry: entry({ key: "report-5", kind: "report", label: "City annual report", dateLabel: "2019", headline: "The City bought the land", quoted: false, lead: "Land purchase" }) }));
    expect(line).not.toContain("<blockquote");
    expect(line).toContain("Land purchase");
    expect(line).toContain("The City bought the land");
  });

  it("passes the admin controls through", () => {
    expect(html(h(EntryRow, { entry: entry(), renderAdmin: () => h("button", null, "Remove from this address") }))).toContain("Remove from this address");
  });
});

describe("sourceTimelineEntry", () => {
  const source = (over: Partial<Source> = {}): Source => ({ id: 7, origin: "press", publisher: "CHEK News", title: "Parks plan", url: "https://chek.test/p", published_on: "2026-07-22", happened_on: "2026-07-22", headline: "Plan recommends a sale", quote: "The site should not be developed.", ...over });
  const urlFor = (k: string | null | undefined) => (k ? `https://cdn.test/${k}` : null);

  it("builds the row both timelines draw", () => {
    expect(sourceTimelineEntry(source(), urlFor)).toMatchObject({
      key: "source-7", date: "2026-07-22", kind: "source", label: "Reported by CHEK News", headline: "Plan recommends a sale",
      detail: "The site should not be developed.", href: "https://chek.test/p", external: true, archiveHref: null, linkTitle: "CHEK News",
      linkHint: "Parks plan", compact: false, images: [], video: null, dateLabel: null,
    });
  });
  it("carries the archive copy only when it differs, the small-row flag as text or boolean, and the approximate date", () => {
    expect(sourceTimelineEntry(source({ archive_url: "https://web.archive.org/x" }), urlFor).archiveHref).toBe("https://web.archive.org/x");
    expect(sourceTimelineEntry(source({ archive_url: "https://chek.test/p" }), urlFor).archiveHref).toBeNull();
    expect(sourceTimelineEntry(source({ compact: "true" }), urlFor).compact).toBe(true);
    expect(sourceTimelineEntry(source({ compact: true }), urlFor).compact).toBe(true);
    expect(sourceTimelineEntry(source({ date_label: "Spring 2019" }), urlFor).dateLabel).toBe("Spring 2019");
  });
  it("turns a YouTube link into a video and a Watch pill, and its pictures into links", () => {
    const row = sourceTimelineEntry(source({ url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", images: [{ r2_key: "a-preview.jpg", w: 1, h: 2, alt: "x", file_key: "a.pdf" }] }), urlFor);
    expect(row.video).toEqual({ id: "dQw4w9WgXcQ", title: "Parks plan" });
    expect(row.linkTitle).toBe("Watch on YouTube");
    expect(row.images).toEqual([{ url: "https://cdn.test/a-preview.jpg", href: "https://cdn.test/a.pdf", pdf: true, w: 1, h: 2, alt: "x", caption: null }]);
  });
  it("has no detail when the source has no quote", () => {
    expect(sourceTimelineEntry(source({ quote: null }), urlFor).detail).toBeNull();
  });
});

describe("outcomeOf", () => {
  it("is defeated if any decision was, else postponed, else passed, else nothing", () => {
    expect(outcomeOf([{ result: "CARRIED" }, { result: "DEFEATED" }])).toEqual({ label: "Defeated", variant: "danger" });
    expect(outcomeOf([{ result: "CARRIED" }, { result: "TABLED" }])).toEqual({ label: "Postponed", variant: "warning" });
    expect(outcomeOf([{ result: "CARRIED" }])).toEqual({ label: "Passed", variant: "success" });
    expect(outcomeOf([{ result: "" }])).toBeNull();
    expect(outcomeOf([])).toBeNull();
    expect(outcomeOf(null)).toBeNull();
  });
});

describe("a routine step on a topic page", () => {
  const item = {
    id: 1, title: "BYLAW NO. 1334 adoption", meeting_id: 9, plain_english_summary: null,
    meetings: { slug: "2011-07-18-regular-council", meeting_date: "2011-07-18", organizations: { name: "Council" } },
    motions: [{ id: 1, result: "CARRIED", disposition: "Substantive", text_content: "That Council adopt Bylaw No. 1334.", votes: [] }],
  };
  it("is a faded card, not bare text, and never repeats \"Final approval.\" under a headline that says it", () => {
    const out = html(h(TimelineStep, { item, headline: "Latecomer interest-rate bylaw made final", docs: [] }));
    expect(out).toContain(FADED_CARD.split(" ")[0]);
    expect(out).toContain("Latecomer interest-rate bylaw made final");
    expect(out).not.toContain("Final approval.");
  });
});
