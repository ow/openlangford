/**
 * Sources outside the meeting record (sources table): a City news release or notice, a news report, another
 * document. Each is a dated statement with a quote and a link, labelled on the page by who said it. See
 * docs/page-review-fixes.md ("Sources").
 */

import { formatDate } from "./utils";

export type SourceOrigin = "city" | "press" | "other";

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
  images?: { r2_key: string; w: number; h: number; alt: string }[] | null;
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
export function sourceByline(s: Pick<Source, "origin" | "publisher" | "published_on" | "happened_on"> & { url?: string | null }): string {
  const base = sourceLabel(s);
  if (!s.published_on || s.published_on === s.happened_on) return base;
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
