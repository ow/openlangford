/**
 * One place for the public base URL of images kept in R2 (extracted report images, meeting
 * posters, share cards), and for turning stored URLs into URLs on that base.
 *
 * DOCUMENT_IMAGE_CDN_BASE_URL (a custom domain on the bucket, cached by Cloudflare's CDN) wins
 * when set; otherwise DOCUMENT_IMAGE_PUBLIC_BASE_URL (today the rate-limited r2.dev URL).
 * See docs/images-cdn.md.
 */

// The bucket name the pipeline writes to; the old r2.dev base carries it as a path segment.
const BUCKET_SEGMENT = "viewroyal-document-images";

export function imageBaseUrl(): string {
  return (
    process.env.DOCUMENT_IMAGE_CDN_BASE_URL ||
    process.env.DOCUMENT_IMAGE_PUBLIC_BASE_URL ||
    process.env.R2_PUBLIC_URL ||
    ""
  ).replace(/\/+$/, "");
}

/** Public URL for an R2 object key, or null when no base is configured. */
export function imageUrlForKey(r2Key: string | null | undefined, base: string = imageBaseUrl()): string | null {
  if (!base || !r2Key) return null;
  return `${base}/${r2Key.replace(/^\/+/, "")}`;
}

/**
 * Pipeline rows (meetings.meta.poster/share_card/title_card .url) store absolute r2.dev URLs.
 * Rewrite those to the configured base so they get the CDN once the base moves; any other
 * URL (and anything when no base is set) passes through unchanged.
 */
export function rewriteImageUrl<T>(url: T, base: string = imageBaseUrl()): T | string {
  if (typeof url !== "string" || !url || !base) return url;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  if (!parsed.hostname.endsWith(".r2.dev")) return url;
  const key = parsed.pathname.replace(/^\/+/, "").replace(new RegExp(`^${BUCKET_SEGMENT}/`), "");
  if (!key) return url;
  return `${base}/${key}${parsed.search}`;
}
