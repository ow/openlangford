import { SITE_NAME } from "./site-name";
import { ogImageUrl, ogUrl } from "./og";

/** Date-only civic records must not shift a day with the server timezone. */
export function recordDate(value: string): string {
  const date = new Date(`${value.slice(0, 10)}T12:00:00Z`);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleDateString("en-CA", {
    year: "numeric", month: "long", day: "numeric", timeZone: "UTC",
  });
}

/** Cut at a word boundary, adding an ellipsis, so text fits `max` characters. */
export function clip(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.\u2014\u2013-]+$/, "")}…`;
}

/** Search snippets show ~155 characters; longer descriptions are cut mid-thought. */
export function metaDescription(text: string, max = 155): string {
  return clip(text, max);
}

/**
 * "<lead> | <context> | Open Langford", trimming the lead (never the context) to keep the title near
 * `max` characters, which is about what a results page shows.
 */
export function fitTitle(lead: string, context?: string, max = 65): string {
  const suffix = `${context ? ` | ${context}` : ""} | ${SITE_NAME}`;
  return `${clip(lead, Math.max(24, max - suffix.length))}${suffix}`;
}

type PageMetaOptions = {
  /** The whole title/og:title when it isn't "<title> | Open Langford" (see fitTitle). */
  fullTitle?: string;
  image?: string;
  imageWidth?: number;
  imageHeight?: number;
};

export function pageMeta(title: string, rawDescription: string, path: string, type = "website", opts: PageMetaOptions = {}) {
  const fullTitle = opts.fullTitle || `${title} | ${SITE_NAME}`;
  const description = metaDescription(rawDescription);
  const image = opts.image || ogImageUrl(title);
  return [
    { title: fullTitle },
    { name: "description", content: description },
    { property: "og:title", content: fullTitle },
    { property: "og:description", content: description },
    { property: "og:type", content: type },
    { property: "og:url", content: ogUrl(path) },
    { property: "og:site_name", content: SITE_NAME },
    { property: "og:image", content: image },
    { property: "og:image:width", content: String(opts.imageWidth || 1200) },
    { property: "og:image:height", content: String(opts.imageHeight || 630) },
    { name: "twitter:card", content: "summary_large_image" },
    { name: "twitter:title", content: fullTitle },
    { name: "twitter:description", content: description },
    { name: "twitter:image", content: image },
  ];
}

export function markdownAlternate(path: string) {
  return { tagName: "link" as const, rel: "alternate", type: "text/markdown", href: ogUrl(path), title: "Markdown representation" };
}
