import { describe, expect, it } from "vitest";
import { imageUrlForKey, rewriteImageUrl } from "../image-url";

const OLD = "https://pub-abc.r2.dev/viewroyal-document-images";
const CDN = "https://images.openlangford.ca";

describe("rewriteImageUrl", () => {
  it("moves a stored r2.dev URL (bucket segment included) onto the CDN base", () => {
    expect(rewriteImageUrl(`${OLD}/meetings/7/posters/12-v1.webp`, CDN)).toBe(`${CDN}/meetings/7/posters/12-v1.webp`);
  });
  it("handles r2.dev URLs without the bucket segment and keeps the query", () => {
    expect(rewriteImageUrl("https://pub-abc.r2.dev/documents/1/2/3.webp?v=2", CDN)).toBe(`${CDN}/documents/1/2/3.webp?v=2`);
  });
  it("is stable when the base is still r2.dev", () => {
    expect(rewriteImageUrl(`${OLD}/documents/1/2/3.webp`, OLD)).toBe(`${OLD}/documents/1/2/3.webp`);
  });
  it("leaves other hosts, nulls, junk and unset bases alone", () => {
    expect(rewriteImageUrl("https://example.com/a.webp", CDN)).toBe("https://example.com/a.webp");
    expect(rewriteImageUrl(null, CDN)).toBeNull();
    expect(rewriteImageUrl(undefined, CDN)).toBeUndefined();
    expect(rewriteImageUrl("not a url", CDN)).toBe("not a url");
    expect(rewriteImageUrl(`${OLD}/x.webp`, "")).toBe(`${OLD}/x.webp`);
  });
});

describe("imageUrlForKey", () => {
  it("joins base and key, trimming slashes", () => {
    expect(imageUrlForKey("/documents/1/2/3.webp", CDN)).toBe(`${CDN}/documents/1/2/3.webp`);
  });
  it("returns null without a key or base", () => {
    expect(imageUrlForKey(null, CDN)).toBeNull();
    expect(imageUrlForKey("a.webp", "")).toBeNull();
  });
});
