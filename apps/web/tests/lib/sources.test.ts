import { describe, expect, it } from "vitest";
import { publisherFor, sourceImages, sourceLabel, tidyQuote } from "../../app/lib/sources";

describe("publisherFor", () => {
  it("names the publishers the records cite, and the City's own site as the City", () => {
    expect(publisherFor("https://www.vicnews.com/news/langford-buys-2-2-million-oceanfront-property/")).toEqual({ publisher: "Victoria News", origin: "press" });
    expect(publisherFor("https://langford.ca/news/some-release/")).toEqual({ publisher: "City of Langford", origin: "city" });
    expect(publisherFor("https://www.cheknews.ca/city-of-langford-considers-selling-oceanfront-property/")).toEqual({ publisher: "CHEK News", origin: "press" });
  });
  it("falls back to the host for anyone else, and to nothing for a bad link", () => {
    expect(publisherFor("https://example.org/story")).toEqual({ publisher: "example.org", origin: "press" });
    expect(publisherFor("not a link")).toEqual({ publisher: "", origin: "other" });
  });
});

describe("sourceLabel", () => {
  it("says who said it", () => {
    expect(sourceLabel({ origin: "press", publisher: "Victoria News" })).toBe("Reported by Victoria News");
    expect(sourceLabel({ origin: "city", publisher: "City of Langford news release" })).toBe("City news release");
    expect(sourceLabel({ origin: "city", publisher: "City of Langford" })).toBe("City publication");
  });
});

describe("tidyQuote", () => {
  it("flattens whitespace, drops wrapping quotes and trims long quotes at a word", () => {
    expect(tidyQuote('  “The City  paid\n close to $2.2 million.”  ')).toBe("The City paid close to $2.2 million.");
    const long = tidyQuote("word ".repeat(100), 50);
    expect(long.length).toBeLessThanOrEqual(50);
    expect(long.endsWith("…")).toBe(true);
    expect(long).not.toMatch(/\s…$/);
  });
});

describe("waybackArchiveUrl", () => {
  it("reads the copy's address from the save's final URL or its content-location, and keeps a Wayback link as its own copy", async () => {
    const { waybackArchiveUrl } = await import("../../app/lib/sources");
    const live = "https://www.cheknews.ca/story-1338026/";
    expect(waybackArchiveUrl(live, "https://web.archive.org/web/20261108120000/https://www.cheknews.ca/story-1338026/", null))
      .toBe("https://web.archive.org/web/20261108120000/https://www.cheknews.ca/story-1338026/");
    expect(waybackArchiveUrl(live, "https://web.archive.org/save/https://www.cheknews.ca/story-1338026/", "/web/20261108120000/https://www.cheknews.ca/story-1338026/"))
      .toBe("https://web.archive.org/web/20261108120000/https://www.cheknews.ca/story-1338026/");
    expect(waybackArchiveUrl(live, "https://web.archive.org/save/https://www.cheknews.ca/story-1338026/", null)).toBeNull();
    const copy = "https://web.archive.org/web/20191113225515/https://www.vicnews.com/news/x/";
    expect(waybackArchiveUrl(copy, null, null)).toBe(copy);
  });
});

describe("sourceByline", () => {
  it("adds the publication date when it is not the day the thing happened", async () => {
    const { sourceByline } = await import("../../app/lib/sources");
    expect(sourceByline({ origin: "press", publisher: "Victoria News", published_on: "2019-11-02", happened_on: "2019-05-07" })).toBe("Reported by Victoria News on Nov 2, 2019");
    expect(sourceByline({ origin: "press", publisher: "CHEK News", published_on: "2026-07-22", happened_on: "2026-07-22" })).toBe("Reported by CHEK News");
    // Reported the next day: the same date to a reader, so only one is shown.
    expect(sourceByline({ origin: "press", publisher: "Island Social Trends", published_on: "2019-08-14", happened_on: "2019-08-13" })).toBe("Reported by Island Social Trends");
    // An approximate date earns the second one, even a day later.
    expect(sourceByline({ origin: "press", publisher: "Victoria News", published_on: "2019-11-02", happened_on: "2019-11-01", date_label: "Fall 2019" })).toBe("Reported by Victoria News on Nov 2, 2019");
    expect(sourceByline({ origin: "city", publisher: "City of Langford", published_on: null, happened_on: "2020-03-02" })).toBe("City publication");
  });
});

describe("youtubeId and the video label", () => {
  it("finds the id in every link shape and refuses anything else", async () => {
    const { youtubeId, sourceLabel, sourceByline } = await import("../../app/lib/sources");
    expect(youtubeId("https://www.youtube.com/watch?v=DHWFwIrqX6s")).toBe("DHWFwIrqX6s");
    expect(youtubeId("https://youtu.be/DHWFwIrqX6s?t=12")).toBe("DHWFwIrqX6s");
    expect(youtubeId("https://m.youtube.com/watch?v=DHWFwIrqX6s&feature=share")).toBe("DHWFwIrqX6s");
    expect(youtubeId("https://www.youtube.com/embed/DHWFwIrqX6s")).toBe("DHWFwIrqX6s");
    expect(youtubeId("https://www.youtube.com/shorts/DHWFwIrqX6s")).toBe("DHWFwIrqX6s");
    expect(youtubeId("https://www.youtube.com/watch?v=short")).toBeNull();
    expect(youtubeId("https://example.com/watch?v=DHWFwIrqX6s")).toBeNull();
    expect(youtubeId("https://www.youtube.com/watch?v=\"><script>x")).toBeNull();
    expect(youtubeId(null)).toBeNull();
    expect(sourceLabel({ origin: "other", publisher: "Vancouver Island & BC", url: "https://www.youtube.com/watch?v=DHWFwIrqX6s" })).toBe("YouTube video by Vancouver Island & BC");
    expect(sourceLabel({ origin: "other", publisher: "YouTube", url: "https://youtu.be/DHWFwIrqX6s" })).toBe("YouTube video");
    expect(sourceLabel({ origin: "other", publisher: "Province of British Columbia", url: "https://gov.bc.ca/x" })).toBe("From Province of British Columbia");
    expect(sourceLabel({ origin: "press", publisher: "CHEK News", url: "https://cheknews.ca/x" })).toBe("Reported by CHEK News");
    expect(sourceByline({ origin: "other", publisher: "Vancouver Island & BC", published_on: "2024-11-24", happened_on: "2024-11-24", url: "https://youtu.be/DHWFwIrqX6s" })).toBe("YouTube video by Vancouver Island & BC");
  });
});

describe("sourceImages", () => {
  const urlFor = (key: string | null | undefined) => (key ? `https://cdn.test/${key}` : null);

  it("links a picture that previews a PDF to the PDF, and marks it", () => {
    expect(sourceImages([{ r2_key: "s/12/table-preview.jpg", w: 1426, h: 1102, alt: "The City's table", file_key: "s/12/table.pdf", caption: "As released." }], urlFor))
      .toEqual([{ url: "https://cdn.test/s/12/table-preview.jpg", href: "https://cdn.test/s/12/table.pdf", pdf: true, w: 1426, h: 1102, alt: "The City's table", caption: "As released." }]);
  });

  it("keeps a plain picture linking to itself", () => {
    expect(sourceImages([{ r2_key: "s/12/photo.jpg", w: 10, h: 20, alt: "a" }], urlFor))
      .toEqual([{ url: "https://cdn.test/s/12/photo.jpg", href: "https://cdn.test/s/12/photo.jpg", pdf: false, w: 10, h: 20, alt: "a", caption: null }]);
  });

  it("leaves out a picture with no public URL, and copes with none at all", () => {
    expect(sourceImages([{ r2_key: "", w: 1, h: 1, alt: "x" }], urlFor)).toEqual([]);
    expect(sourceImages(null, urlFor)).toEqual([]);
    expect(sourceImages(undefined, urlFor)).toEqual([]);
  });
});
