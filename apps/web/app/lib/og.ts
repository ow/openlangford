/** Canonical public origin; used for share links, the sitemap and robots.txt. */
export const SITE_ORIGIN = "https://openlangford.ca";
const BASE = SITE_ORIGIN;

/**
 * Share-image design version. Bump it when the card layout changes: every og:image URL changes
 * with it, so link previews and the edge/KV caches pick up the new design instead of old PNGs.
 */
export const OG_VERSION = "2";

/** Small label beside the logo on a share card (sentence case, no database words). */
export const OG_LABELS = {
  meeting: "Council meeting",
  person: "Council member",
  council: "Council",
  decision: "Council decision",
  property: "Property",
  street: "Street",
  bylaw: "Bylaw",
  election: "Election",
  search: "Search",
  document: "Council document",
  default: "",
} as const;
export type OgKind = keyof typeof OG_LABELS;

/** Share-image text limits: the card clips anyway; these keep URLs (and cache keys) short. */
export const OG_TITLE_MAX = 140;
export const OG_SUBTITLE_MAX = 200;

/** First sentence of a summary, for a card subtitle. */
export function firstSentence(text: string | null | undefined): string | undefined {
  const clean = (text || "").replace(/[*_#>`]/g, "").replace(/\s+/g, " ").trim();
  if (!clean) return undefined;
  const match = /^(.{20,}?[.!?])\s+[A-Z0-9"“]/.exec(clean);
  return (match ? match[1] : clean).replace(/\.$/, "");
}

function cut(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  const slice = clean.slice(0, max - 1);
  const space = slice.lastIndexOf(" ");
  return `${(space > max * 0.6 ? slice.slice(0, space) : slice).replace(/[\s,;:.—–-]+$/, "")}…`;
}

/**
 * Generated share image (1200×630 PNG, /api/og-image). The URL carries everything the card shows
 * plus OG_VERSION, so a changed title or design gets a new URL and each URL renders once.
 * `image` is a site path to a JPEG/PNG under /images/ (council portraits).
 */
export function ogImageUrl(
  title: string,
  opts?: { subtitle?: string | null; type?: OgKind; image?: string | null },
): string {
  const params = new URLSearchParams({ v: OG_VERSION });
  if (opts?.type && opts.type !== "default") params.set("type", opts.type);
  params.set("title", cut(title, OG_TITLE_MAX));
  if (opts?.subtitle) params.set("subtitle", cut(opts.subtitle, OG_SUBTITLE_MAX));
  if (opts?.image) params.set("image", opts.image);
  return `${BASE}/api/og-image?${params.toString()}`;
}

/** The share-card portrait for a person: the JPEG copy of the site portrait (satori can't read WebP). */
export function ogPortrait(imageUrl: string | null | undefined): string | undefined {
  if (!imageUrl || !imageUrl.startsWith("/images/")) return undefined;
  return imageUrl.replace(/\.webp$/i, ".jpg");
}

export function ogUrl(path: string): string {
  return `${BASE}${path}`;
}
