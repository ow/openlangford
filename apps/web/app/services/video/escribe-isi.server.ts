import { getSupabaseAdminClient } from "../../lib/supabase.server";
import { escribeIsiInfo, isAllowedEscribeUrl } from "./catalog";
import { guessSourceKind, type VideoProvider, type VideoSource } from "./types";

/**
 * eSCRIBE meeting portals embed recordings with ISI Live's stand-alone player
 * (…escribemeetings.com/Players/ISIStandAlonePlayer.aspx?Id=…). The page names
 * the client and file; the recording itself is a plain, non-expiring mp4 on
 * video.isilive.ca.
 */

const PLAYER_PATH = "/players/isistandaloneplayer.aspx";
const CACHE_TTL = 3600 * 1000;
const cache = new Map<string, { source: VideoSource; at: number }>();

function extractHtmlAttr(html: string, attr: string): string | null {
  const pattern = new RegExp(`${attr}=["']([^"']+)["']`, "i");
  return html.match(pattern)?.[1] || null;
}

export function isIsiPlayerUrl(videoUrl: string): boolean {
  if (!isAllowedEscribeUrl(videoUrl)) return false;
  return new URL(videoUrl).pathname.toLowerCase().includes(PLAYER_PATH);
}

async function fetchIsiSource(videoUrl: string): Promise<VideoSource | null> {
  if (!isIsiPlayerUrl(videoUrl)) return null;

  const response = await fetch(videoUrl, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    },
  });
  if (!response.ok) return null;

  const html = await response.text();
  const clientId = extractHtmlAttr(html, "data-client_id");
  const fileName = extractHtmlAttr(html, "data-file_name");
  if (!clientId || !fileName) return null;

  const url = `https://video.isilive.ca/${encodeURIComponent(clientId)}/${encodeURIComponent(fileName)}`;
  return { url, audioUrl: null, kind: guessSourceKind(url), expiresAt: null };
}

export const escribeIsiProvider: VideoProvider = {
  ...escribeIsiInfo,
  async resolveSource(videoUrl) {
    const hit = cache.get(videoUrl);
    if (hit && Date.now() - hit.at < CACHE_TTL) return hit.source;
    const source = await fetchIsiSource(videoUrl);
    if (source) cache.set(videoUrl, { source, at: Date.now() });
    return source;
  },
  async invalidate(meetingId, videoUrl) {
    // Nothing is stored in the database for ISI streams; only this isolate's cache.
    let url = videoUrl;
    if (url === null) {
      const { data, error } = await getSupabaseAdminClient()
        .from("meetings")
        .select("video_url")
        .eq("id", meetingId)
        .maybeSingle();
      if (error) throw error;
      if (!data) return false;
      url = data.video_url;
    }
    if (url) cache.delete(url);
    return true;
  },
};
