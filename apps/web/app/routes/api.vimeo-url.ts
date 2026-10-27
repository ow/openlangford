import { getVimeoVideoData } from "../services/vimeo.server";
import { createSupabaseServerClient } from "../lib/supabase.server";
import { getMunicipality } from "../services/municipality";
import { isRateLimited, tooManyRequests } from "../lib/rate-limit.server";

const ESCRIBE_HOST = "escribemeetings.com";

/** Strict allowlist: https and escribemeetings.com or a subdomain (e.g. pub-langford.escribemeetings.com). */
export function isAllowedEscribeUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return (
      u.protocol === "https:" &&
      (u.hostname === ESCRIBE_HOST || u.hostname.endsWith(`.${ESCRIBE_HOST}`))
    );
  } catch {
    return false;
  }
}

function extractHtmlAttr(html: string, attr: string): string | null {
  const pattern = new RegExp(`${attr}=["']([^"']+)["']`, "i");
  return html.match(pattern)?.[1] || null;
}

async function getIsiVideoData(videoUrl: string) {
  const parsed = new URL(videoUrl);
  if (!isAllowedEscribeUrl(videoUrl)) return null;
  if (!parsed.pathname.toLowerCase().includes("/players/isistandaloneplayer.aspx")) {
    return null;
  }

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

  return {
    direct_url: `https://video.isilive.ca/${encodeURIComponent(clientId)}/${encodeURIComponent(fileName)}`,
    direct_audio_url: null,
  };
}

export async function loader({ request, context }: { request: Request; context?: any }) {
  const url = new URL(request.url);
  const videoUrl = url.searchParams.get("video_url");
  const meetingId = url.searchParams.get("meeting_id");

  if (!videoUrl) {
    return Response.json({ error: "video_url required" }, { status: 400 });
  }

  // Only eSCRIBE or Vimeo https URLs are ever fetched/proxied; reject anything else up front.
  let parsedVideo: URL;
  try {
    parsedVideo = new URL(videoUrl);
  } catch {
    return Response.json({ error: "Invalid video_url" }, { status: 400 });
  }
  const host = parsedVideo.hostname;
  const isVimeo = host === "vimeo.com" || host.endsWith(".vimeo.com");
  if (parsedVideo.protocol !== "https:" || !(isAllowedEscribeUrl(videoUrl) || isVimeo)) {
    return Response.json({ error: "Unsupported video_url host" }, { status: 400 });
  }

  if (await isRateLimited(request, "vimeo-url", 30, context)) return tooManyRequests();

  try {
    const isiResult = await getIsiVideoData(videoUrl);
    if (isiResult) return Response.json(isiResult);

    const { supabase } = createSupabaseServerClient(request);
    const municipality = await getMunicipality(supabase);
    const result = await getVimeoVideoData(videoUrl, meetingId || undefined, municipality.website_url);
    return Response.json({
      direct_url: result?.direct_url || null,
      direct_audio_url: result?.direct_audio_url || null,
    });
  } catch {
    return Response.json({ direct_url: null, direct_audio_url: null });
  }
}
