import type { VideoProviderInfo } from "./catalog";

export type VideoSourceKind = "mp4" | "hls" | "dash" | "unknown";

/** A stream the <video> element can play, resolved from a meeting's stored video_url. */
export interface VideoSource {
  url: string;
  audioUrl: string | null;
  kind: VideoSourceKind;
  /** When the provider's signed URL stops working (ISO time), or null if it doesn't expire. */
  expiresAt: string | null;
}

export interface ResolveContext {
  meetingId?: number | string;
  /** Municipality website, sent as the Referer for domain-restricted Vimeo videos. */
  websiteUrl?: string | null;
  /** The municipality's `source_config.video_source` object (provider-specific settings). */
  providerConfig?: Record<string, unknown> | null;
}

export interface VideoProvider extends VideoProviderInfo {
  resolveSource(videoUrl: string, ctx?: ResolveContext): Promise<VideoSource | null>;
  /**
   * Forget any cached or broken stream for this meeting, so the next resolve
   * fetches a fresh one. Returns false when the meeting doesn't exist.
   */
  invalidate(meetingId: number, videoUrl: string | null): Promise<boolean>;
}

export function guessSourceKind(url: string): VideoSourceKind {
  let path: string;
  try {
    path = new URL(url).pathname.toLowerCase();
  } catch {
    path = url.toLowerCase();
  }
  if (path.endsWith(".m3u8") || path.includes("/hls/") || path.includes("playlist")) return "hls";
  if (path.endsWith(".mpd") || path.includes("/dash/")) return "dash";
  if (path.endsWith(".mp4") || path.endsWith(".m4v") || path.endsWith(".mov")) return "mp4";
  return "unknown";
}
