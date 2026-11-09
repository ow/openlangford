/**
 * Sources outside the meeting record (sources table): a City news release or notice, a news report, another
 * document. Each is a dated statement with a quote and a link, labelled on the page by who said it. See
 * docs/page-review-fixes.md ("Sources").
 */

import { formatDate } from "./utils";
import type { TimelineEntry } from "./timeline-entry";

export type SourceOrigin = "city" | "press" | "other";

/** A picture kept with a source (meta.images). `r2_key` is the picture shown; `file_key` is a document it previews (a
 * PDF in the same bucket), which the picture then opens; `caption` replaces the default line under the pictures. */
export type SourceImage = { r2_key: string; w: number; h: number; alt: string; file_key?: string | null; caption?: string | null };

/** What a timeline row shows for a source's pictures: the picture, where a click goes (the PDF when there is one), and
 * the caption. Entries whose picture has no public URL are left out. */
export function sourceImages(images: SourceImage[] | null | undefined, urlFor: (key: string | null | undefined) => string | null) {
  return (images || []).map((im) => {
    const url = urlFor(im.r2_key) || "";
    const file = im.file_key ? urlFor(im.file_key) : null;
    return { url, href: file || url, pdf: !!file, w: im.w, h: im.h, alt: im.alt, caption: im.caption || null };
  }).filter((im) => im.url);
}

export type Source = {
  id: number;
  origin: SourceOrigin;
  publisher: string;
  title: string;
  url: string | null;
  published_on: string | null;
  happened_on: string;
  headline: string;
  quote: string | null;
  note?: string | null;
  /** A Wayback Machine copy of the link, requested when the source was added; shown as "archived copy". */
  archive_url?: string | null;
  /** How to show the date when the source gives only a season or a month ("Spring 2019"); happened_on still orders it. */
  date_label?: string | null;
  /** Pictures kept with the source (R2 keys), such as the City's FOI table and letter. meta.images. */
  images?: SourceImage[] | null;
  /** Shown as a small one-line row on the timeline (thin context: a notice, an advisory). meta.compact, as text. */
  compact?: string | boolean | null;
};

/** The archived copy's address from a Wayback save: the final URL after redirects, or the content-location header
 * the save endpoint answers with. A link that already points at the Wayback Machine is its own copy. */
export function waybackArchiveUrl(original: string, finalUrl: string | null, contentLocation: string | null): string | null {
  const isCopy = (u: string | null) => !!u && /^https?:\/\/web\.archive\.org\/web\/\d{4,14}/.test(u);
  if (isCopy(original)) return original;
  if (isCopy(finalUrl) && !/\/save\//.test(finalUrl!)) return finalUrl;
  if (contentLocation && /^\/web\/\d{4,14}/.test(contentLocation)) return `https://web.archive.org${contentLocation}`;
  if (isCopy(contentLocation)) return contentLocation;
  return null;
}

/** The id of a YouTube video from any of its link shapes (watch, youtu.be, embed, shorts, live), or null. */
export function youtubeId(url: string | null | undefined): string | null {
  if (!url) return null;
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  const host = u.hostname.toLowerCase().replace(/^www\.|^m\./, "");
  let id: string | null = null;
  if (host === "youtu.be") id = u.pathname.slice(1).split("/")[0];
  else if (host === "youtube.com" || host === "youtube-nocookie.com") {
    id = u.searchParams.get("v") || u.pathname.match(/^\/(?:embed|shorts|live|v)\/([^/?]+)/)?.[1] || null;
  }
  return id && /^[\w-]{11}$/.test(id) ? id : null;
}

/** Who said it, as the page labels it: "City news release" for the City's own words, "Reported by Victoria News"
 * for someone else's, "YouTube video by <channel>" for a video, "From <body>" for another document. */
export function sourceLabel(s: Pick<Source, "origin" | "publisher"> & { url?: string | null }): string {
  if (s.origin === "city") return /release|news/i.test(s.publisher) ? "City news release" : "City publication";
  // YouTube is the source; the channel is who made it.
  if (youtubeId(s.url)) return s.publisher && !/^youtube$/i.test(s.publisher) ? `YouTube video by ${s.publisher}` : "YouTube video";
  if (s.origin === "other") return `From ${s.publisher}`;
  return `Reported by ${s.publisher}`;
}

/** "Reported by Victoria News on Nov 2, 2019": who said it, and when they said it, when that is not the day it happened. */
export function sourceByline(s: Pick<Source, "origin" | "publisher" | "published_on" | "happened_on" | "date_label"> & { url?: string | null }): string {
  const base = sourceLabel(s);
  if (!s.published_on || s.published_on === s.happened_on) return base;
  // The row already shows a date. A second one earns its place when the first is approximate ("Spring 2019") or the
  // source came out well after the event; a report the next day is the same date to a reader.
  const gapDays = Math.abs(Date.parse(s.published_on) - Date.parse(s.happened_on)) / 86_400_000;
  if (!s.date_label && !(gapDays >= 14)) return base;
  return `${base} on ${formatDate(s.published_on, { year: "numeric", month: "short", day: "numeric" })}`;
}

/** Publishers the records cite often, by host; anything else is labelled by its host name. */
const PUBLISHERS: [RegExp, string, SourceOrigin][] = [
  [/(^|\.)langford\.ca$/, "City of Langford", "city"],
  [/escribemeetings\.com$/, "City of Langford", "city"],
  [/vicnews\.com$/, "Victoria News", "press"],
  [/goldstreamgazette\.com$/, "Goldstream Gazette", "press"],
  [/timescolonist\.com$/, "Times Colonist", "press"],
  [/cheknews\.ca$/, "CHEK News", "press"],
  [/(^|\.)youtube\.com$|^youtu\.be$/, "YouTube", "other"],
  [/islandsocialtrends\.ca$/, "Island Social Trends", "press"],
  [/capitaldaily\.ca$/, "Capital Daily", "press"],
  [/cbc\.ca$/, "CBC News", "press"],
  [/globalnews\.ca$/, "Global News", "press"],
  [/ctvnews\.ca$/, "CTV News", "press"],
  [/(^|\.)gov\.bc\.ca$/, "Province of British Columbia", "other"],
  [/crd\.bc\.ca$/, "Capital Regional District", "other"],
];

/** The publisher and origin a link's host implies, for the draft; staff can change both. */
export function publisherFor(url: string): { publisher: string; origin: SourceOrigin } {
  let host = "";
  try { host = new URL(url).hostname.toLowerCase().replace(/^www\./, ""); } catch { return { publisher: "", origin: "other" }; }
  for (const [test, publisher, origin] of PUBLISHERS) if (test.test(host)) return { publisher, origin };
  return { publisher: host, origin: "press" };
}

/** A quote trimmed to one tidy line, without stray quotation marks or a trailing fragment marker. */
export function tidyQuote(q: string | null | undefined, max = 320): string {
  const flat = (q || "").replace(/\s+/g, " ").trim().replace(/^[“"']+|[”"']+$/g, "").trim();
  return flat.length > max ? flat.slice(0, max - 1).replace(/\s+\S*$/, "") + "…" : flat;
}

/** A source as a row on a timeline (an address's or a topic's): the label says who said it, the quote is its own
 * words, and a link, an archive copy, a video, pictures and the small-row flag come with it. `urlFor` turns a stored
 * picture key into its public address (server-side: lib/document-images.server). */
export function sourceTimelineEntry(s: Source, urlFor: (key: string | null | undefined) => string | null): TimelineEntry {
  const video = youtubeId(s.url);
  return {
    key: `source-${s.id}`, date: s.happened_on, kind: "source", label: sourceByline(s), dateLabel: s.date_label || null,
    headline: s.headline, detail: s.quote ? tidyQuote(s.quote, 700) : null, href: s.url, external: !!s.url,
    archiveHref: s.archive_url && s.archive_url !== s.url ? s.archive_url : null,
    linkTitle: video ? "Watch on YouTube" : s.publisher, linkHint: s.title, compact: s.compact === true || s.compact === "true",
    images: sourceImages(s.images, urlFor),
    video: video ? { id: video, title: s.title } : null,
  };
}
