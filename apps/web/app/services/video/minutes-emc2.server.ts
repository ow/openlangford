import { isMinutesEmc2RecordingUrl, minutesEmc2Info } from "./catalog";
import type { VideoProvider } from "./types";

/** Browsers play these public MP4s directly; the Worker does not fetch or proxy them. */
export const minutesEmc2Provider: VideoProvider = {
  ...minutesEmc2Info,
  async resolveSource(url) {
    if (!isMinutesEmc2RecordingUrl(url)) return null;
    return { url: new URL(url).href, audioUrl: null, kind: "mp4", expiresAt: null };
  },
  async invalidate(_meetingId, videoUrl) {
    // A static source has no cached or expiring URL to invalidate.
    return Boolean(videoUrl && isMinutesEmc2RecordingUrl(videoUrl));
  },
};
