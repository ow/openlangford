import { describe, expect, it } from "vitest";
import { publisherFor, sourceLabel, tidyQuote } from "../../app/lib/sources";

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
