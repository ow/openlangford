import { createSupabaseServerClient } from "../lib/supabase.server";
import { getMunicipality } from "../services/municipality";
import { isRateLimited, tooManyRequests } from "../lib/rate-limit.server";
import { getVideoProvider, getVideoSourceSetting } from "../services/video/index.server";

export { isAllowedEscribeUrl } from "../services/video/catalog";

/**
 * GET /api/video-source?video_url=…&meeting_id=…
 *
 * Resolves a meeting's published video page into a stream the <video> element
 * can play, through the municipality's video provider. Only URLs a registered
 * provider owns are ever fetched. /api/vimeo-url is an alias of this route.
 */
export async function loader({ request, context }: { request: Request; context?: any }) {
  const url = new URL(request.url);
  const videoUrl = url.searchParams.get("video_url");
  const meetingId = url.searchParams.get("meeting_id");

  if (!videoUrl) {
    return Response.json({ error: "video_url required" }, { status: 400 });
  }
  try {
    new URL(videoUrl);
  } catch {
    return Response.json({ error: "Invalid video_url" }, { status: 400 });
  }
  // Host check before anything else: unknown or non-https URLs are never fetched.
  if (!getVideoProvider(videoUrl)) {
    return Response.json({ error: "Unsupported video_url host" }, { status: 400 });
  }

  if (await isRateLimited(request, "vimeo-url", 30, context)) return tooManyRequests();

  const empty = { direct_url: null, direct_audio_url: null };
  try {
    const { supabase } = createSupabaseServerClient(request);
    const setting = await getVideoSourceSetting(supabase);
    const provider = getVideoProvider(videoUrl, setting.id);
    if (!provider) return Response.json(empty);

    // Only Vimeo needs the municipality website (as Referer for domain-restricted videos).
    const websiteUrl =
      provider.id === "vimeo" ? (await getMunicipality(supabase).catch(() => null))?.website_url : null;
    const source = await provider.resolveSource(videoUrl, {
      meetingId: meetingId || undefined,
      websiteUrl,
      // Provider settings only apply to the configured provider.
      providerConfig: setting.id === provider.id ? setting.config : null,
    });
    return Response.json({
      provider: provider.id,
      direct_url: source?.url ?? null,
      direct_audio_url: source?.audioUrl ?? null,
      kind: source?.kind ?? null,
      expires_at: source?.expiresAt ?? null,
    });
  } catch {
    return Response.json(empty);
  }
}
