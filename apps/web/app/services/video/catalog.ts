/**
 * Video providers: what each one is called, which URLs it owns, how to link
 * into a recording at a given time, and how the privacy page describes it.
 *
 * This file is safe to import in the browser. Resolving a URL into a playable
 * stream and clearing cached streams live in the matching `*.server.ts` files
 * (see ./index.server.ts).
 *
 * A municipality picks its provider with `municipalities.source_config.video_source.type`
 * (the same setting the pipeline reads). When it is missing, or a meeting's URL
 * belongs to a different provider, the provider is detected from the URL host.
 */

export type VideoProviderId = "vimeo" | "escribe-isi";

export interface PrivacyWording {
  /** Phrase for "We use Supabase for …, ___, and PostHog for …", when the site itself uses the service. */
  weUse: string | null;
  /** Separate sentence, when the video is hosted by someone else (for example, the City's own provider). */
  note: string | null;
}

export interface VideoProviderInfo {
  id: VideoProviderId;
  /** Public label for links to the original recording. */
  label: string;
  /** Link text for the fallback when the stream can't be played on this site. */
  watchElsewhereLabel: string;
  /** True when this provider owns (and may fetch) the URL. Strict: https only. */
  matchesUrl(url: string): boolean;
  /** Link to the original recording, at `seconds` when the provider supports it. */
  deepLink(url: string, seconds?: number | null): string;
  privacy(municipalityName: string): PrivacyWording;
}

function parseHttps(raw: string): URL | null {
  try {
    const u = new URL(raw);
    return u.protocol === "https:" ? u : null;
  } catch {
    return null;
  }
}

function hostIs(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

const ESCRIBE_HOST = "escribemeetings.com";

/** Strict allowlist: https and escribemeetings.com or a subdomain (e.g. pub-langford.escribemeetings.com). */
export function isAllowedEscribeUrl(raw: string): boolean {
  const u = parseHttps(raw);
  return Boolean(u && hostIs(u.hostname, ESCRIBE_HOST));
}

export function isVimeoUrl(raw: string): boolean {
  const u = parseHttps(raw);
  return Boolean(u && hostIs(u.hostname, "vimeo.com"));
}

function possessive(municipalityName: string): string {
  const name = municipalityName.trim() || "the City";
  return /^(city|town|district|village|township) of /i.test(name) ? `the ${name}'s` : `${name}'s`;
}

export const vimeoInfo: VideoProviderInfo = {
  id: "vimeo",
  label: "Vimeo",
  watchElsewhereLabel: "Watch on Vimeo",
  matchesUrl: isVimeoUrl,
  deepLink(url, seconds) {
    if (!seconds || seconds <= 0) return url;
    const base = url.split("#")[0];
    return `${base}#t=${Math.floor(seconds)}s`;
  },
  privacy: () => ({ weUse: "Vimeo for video hosting", note: null }),
};

export const escribeIsiInfo: VideoProviderInfo = {
  id: "escribe-isi",
  label: "Official video",
  watchElsewhereLabel: "Watch on the City's site",
  matchesUrl: isAllowedEscribeUrl,
  // The eSCRIBE/ISI stand-alone player has no start-time parameter, so the
  // link always opens at the beginning.
  deepLink: (url) => url,
  privacy: (municipalityName) => ({
    weUse: null,
    note: `Meeting video is hosted by ${possessive(municipalityName)} meeting video provider, eSCRIBE.`,
  }),
};

export const VIDEO_PROVIDERS: Record<VideoProviderId, VideoProviderInfo> = {
  vimeo: vimeoInfo,
  "escribe-isi": escribeIsiInfo,
};

/** Setting values accepted in `source_config.video_source.type`. "isilive" is the pipeline's name. */
const PROVIDER_ALIASES: Record<string, VideoProviderId> = {
  vimeo: "vimeo",
  "escribe-isi": "escribe-isi",
  isilive: "escribe-isi",
  escribe: "escribe-isi",
};

export function normalizeVideoProviderId(raw: unknown): VideoProviderId | null {
  if (typeof raw !== "string") return null;
  return PROVIDER_ALIASES[raw.trim().toLowerCase()] ?? null;
}

export function detectVideoProvider(url: string | null | undefined): VideoProviderInfo | null {
  if (!url) return null;
  return Object.values(VIDEO_PROVIDERS).find((p) => p.matchesUrl(url)) ?? null;
}

/**
 * The provider for a meeting's video URL: the configured one when it owns the
 * URL, otherwise whichever provider the URL host belongs to. Null for URLs no
 * provider owns (never fetched).
 */
export function selectVideoProvider(
  url: string | null | undefined,
  configured?: VideoProviderId | null,
): VideoProviderInfo | null {
  if (!url) return null;
  const preferred = configured ? VIDEO_PROVIDERS[configured] : null;
  if (preferred?.matchesUrl(url)) return preferred;
  return detectVideoProvider(url);
}
