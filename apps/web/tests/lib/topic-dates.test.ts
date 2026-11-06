import { describe, expect, it } from "vitest";
import { longCivicDate, topicModified, topicUpdatedLine } from "../../app/lib/topic-dates";
import { topicArticle } from "../../app/lib/structured-data";

describe("longCivicDate", () => {
  it("writes the Langford calendar day in full", () => {
    expect(longCivicDate("2026-11-05")).toBe("November 5, 2026");
    // 05:30 UTC is still the evening before in Langford.
    expect(longCivicDate("2026-10-02T05:30:00+00:00")).toBe("October 1, 2026");
    expect(longCivicDate("2026-10-02T19:00:00.123456+00:00")).toBe("October 2, 2026");
    expect(longCivicDate(null)).toBeNull();
    expect(longCivicDate("not a date")).toBeNull();
  });
});

describe("topicModified", () => {
  it("is the later of the last visible change and the latest meeting", () => {
    expect(topicModified({ last_seen: "2025-03-03", content_updated_at: "2026-10-02T19:00:00+00:00" })).toBe("2026-10-02T19:00:00+00:00");
    expect(topicModified({ last_seen: "2026-11-02", content_updated_at: "2026-10-02T19:00:00+00:00" })).toBe("2026-11-02");
    expect(topicModified({ last_seen: "2026-11-02", content_updated_at: null })).toBe("2026-11-02");
    expect(topicModified({ last_seen: null, content_updated_at: "2026-10-02T19:00:00+00:00" })).toBe("2026-10-02T19:00:00+00:00");
    expect(topicModified({})).toBeNull();
  });
});

describe("topicUpdatedLine", () => {
  it("shows a change made well after the latest meeting", () => {
    expect(topicUpdatedLine({ last_seen: "2025-03-03", content_updated_at: "2026-11-05T18:00:00+00:00" })).toBe("Updated November 5, 2026");
    // No meetings at all: any change is news.
    expect(topicUpdatedLine({ content_updated_at: "2026-11-05T18:00:00+00:00" })).toBe("Updated November 5, 2026");
    // Without a latest meeting, the first one stands in.
    expect(topicUpdatedLine({ first_seen: "2026-11-01", content_updated_at: "2026-11-05T18:00:00+00:00" })).toBeNull();
  });

  it("stays quiet when the meeting date already says it", () => {
    // Backfilled to the meeting date.
    expect(topicUpdatedLine({ last_seen: "2025-03-03", content_updated_at: "2025-03-03T00:00:00+00:00" })).toBeNull();
    // Filed a few days after the meeting (items, minutes, the summary rewritten to match).
    expect(topicUpdatedLine({ last_seen: "2026-11-02", content_updated_at: "2026-11-12T18:00:00+00:00" })).toBeNull();
    // A scheduled meeting later than the change.
    expect(topicUpdatedLine({ last_seen: "2026-12-07", content_updated_at: "2026-11-05T18:00:00+00:00" })).toBeNull();
    expect(topicUpdatedLine({ last_seen: "2026-11-02", content_updated_at: null })).toBeNull();
  });
});

describe("topicArticle", () => {
  it("dates the page by its first meeting and last change, never updated_at", () => {
    const article = topicArticle(
      { first_seen: "2024-01-08", last_seen: "2025-03-03", content_updated_at: "2026-10-02T19:00:00+00:00", updated_at: "2026-11-05T10:00:00Z" } as any,
      "Caribou Drive rezoning", "/matters/caribou", "Council approved 40 homes.",
    );
    expect(article).toMatchObject({
      "@type": "Article", "@id": "https://openlangford.ca/matters/caribou#topic", headline: "Caribou Drive rezoning",
      url: "https://openlangford.ca/matters/caribou", description: "Council approved 40 homes.",
      datePublished: "2024-01-08", dateModified: "2026-10-02T19:00:00+00:00",
    });
  });

  it("leaves out dates it doesn't have and keeps the headline short", () => {
    const article = topicArticle({}, "x".repeat(200), "/matters/x");
    expect(article).not.toHaveProperty("datePublished");
    expect(article).not.toHaveProperty("dateModified");
    expect(article).not.toHaveProperty("description");
    expect((article.headline as string).length).toBe(110);
  });
});
