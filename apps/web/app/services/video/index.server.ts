import type { SupabaseClient } from "@supabase/supabase-js";
import { DEFAULT_MUNICIPALITY } from "../../lib/site-config";
import { normalizeVideoProviderId, selectVideoProvider, type VideoProviderId } from "./catalog";
import { escribeIsiProvider } from "./escribe-isi.server";
import type { ResolveContext, VideoProvider, VideoSource } from "./types";
import { vimeoProvider } from "./vimeo.server";

export type { VideoProvider, VideoSource, ResolveContext } from "./types";
export * from "./catalog";

export const VIDEO_PROVIDER_IMPLS: Record<VideoProviderId, VideoProvider> = {
  vimeo: vimeoProvider,
  "escribe-isi": escribeIsiProvider,
};

export interface VideoSourceSetting {
  /** Configured provider, or null so callers detect it from the URL host. */
  id: VideoProviderId | null;
  /** The whole `source_config.video_source` object (provider-specific settings such as Vimeo's proxy URLs). */
  config: Record<string, unknown> | null;
}

const settingCache = new Map<string, { setting: VideoSourceSetting; expires: number }>();

/**
 * The municipality's video setting, `source_config.video_source` (shared with
 * the pipeline). Unset or unreadable gives `{ id: null, config: null }`.
 */
export async function getVideoSourceSetting(
  supabase: SupabaseClient | null | undefined,
  slug: string = DEFAULT_MUNICIPALITY.slug,
): Promise<VideoSourceSetting> {
  const cached = settingCache.get(slug);
  if (cached && cached.expires > Date.now()) return cached.setting;
  let setting: VideoSourceSetting;
  try {
    const { data } = await supabase!
      .from("municipalities")
      .select("video_source:source_config->video_source")
      .eq("slug", slug)
      .maybeSingle();
    const raw = (data as { video_source?: unknown } | null)?.video_source;
    const config = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
    setting = { id: normalizeVideoProviderId(config?.type), config };
  } catch {
    return { id: null, config: null }; // don't cache failures
  }
  settingCache.set(slug, { setting, expires: Date.now() + 60_000 });
  return setting;
}

export async function getConfiguredVideoProviderId(
  supabase: SupabaseClient | null | undefined,
  slug?: string,
): Promise<VideoProviderId | null> {
  return (await getVideoSourceSetting(supabase, slug)).id;
}

/** The provider implementation for a URL (configured provider first, then URL host). */
export function getVideoProvider(
  videoUrl: string | null | undefined,
  configured?: VideoProviderId | null,
): VideoProvider | null {
  const info = selectVideoProvider(videoUrl, configured);
  return info ? VIDEO_PROVIDER_IMPLS[info.id] : null;
}

/** Resolve a meeting's stored video_url into a playable stream, or null. */
export async function resolveVideoSource(
  videoUrl: string,
  options: ResolveContext & { setting?: VideoSourceSetting } = {},
): Promise<{ provider: VideoProvider; source: VideoSource | null } | null> {
  const { setting, ...ctx } = options;
  const provider = getVideoProvider(videoUrl, setting?.id);
  if (!provider) return null;
  // Provider settings only apply to the configured provider (Langford's eSCRIBE settings never reach Vimeo).
  const providerConfig = setting?.id === provider.id ? setting.config : null;
  const source = await provider.resolveSource(videoUrl, { ...ctx, providerConfig });
  return { provider, source };
}
