import { describe, expect, it } from "vitest";
import { imageUrlForKey, rewriteImageUrl } from "../image-url";

const OLD = "https://pub-abc.r2.dev/viewroyal-document-images";
const CDN_HOST = "https://images.openlangford.ca";
const CDN = `${CDN_HOST}/viewroyal-document-images`;

describe("rewriteImageUrl", () => {
  it("swaps only the host of a stored r2.dev URL and keeps the full path", () => {
    expect(rewriteImageUrl(`${OLD}/meeting-posters/239/2894-v3.webp`, CDN)).toBe(`${CDN}/meeting-posters/239/2894-v3.webp`);
  });
  it("keeps the query string", () => {
    expect(rewriteImageUrl(`${OLD}/documents/27/311/90.webp?v=2`, CDN)).toBe(`${CDN}/documents/27/311/90.webp?v=2`);
  });
  it("is a no-op when the base is still r2.dev", () => {
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
