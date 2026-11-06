import { pageMeta } from "../lib/page-meta";
import { renderMarkdown } from "../components/markdown-content";
import privacyContent from "../content/privacy.md?raw";
export const meta = () => pageMeta("Privacy policy", "What Open Langford publishes from public records, what it collects when you use the site, who it shares information with, and how to ask for a correction or deletion.", "/privacy");

import { DEFAULT_MUNICIPALITY } from "../lib/site-config";
import { useLoaderData, useRouteLoaderData } from "react-router";
import { createSupabaseServerClient } from "../lib/supabase.server";
import { getConfiguredVideoProviderId } from "../services/video/index.server";
import { VIDEO_PROVIDERS, type VideoProviderId } from "../services/video/catalog";
import type { Municipality } from "../lib/types";
import { PageHeader } from "../components/ui/page-header";

export async function loader({ request }: { request: Request }) {
  const { supabase } = createSupabaseServerClient(request);
  // Default to Vimeo wording (the upstream project's provider) when nothing is configured.
  const videoProvider: VideoProviderId = (await getConfiguredVideoProviderId(supabase)) ?? "vimeo";
  // Rendered on the server so the markdown engine never ships to the browser; the video sentence needs the municipality
  // name from the root loader, so the placeholder is filled in the component.
  return { videoProvider, html: renderMarkdown(privacyContent) };
}

export default function Privacy() {
  const { videoProvider, html: template } = useLoaderData<typeof loader>();
  const rootData = useRouteLoaderData("root") as { municipality?: Municipality } | undefined;
  const municipalityName = rootData?.municipality?.name || DEFAULT_MUNICIPALITY.name;
  const videoPrivacy = VIDEO_PROVIDERS[videoProvider].privacy(municipalityName);
  const videoSentence = videoPrivacy.note ?? (videoPrivacy.weUse ? `We use ${videoPrivacy.weUse}.` : "");
  const html = template.replace("{{video_privacy}}", () => videoSentence.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"));

  return (
    <div className="min-h-screen bg-zinc-50">
      <div className="container mx-auto max-w-3xl px-4 pt-6 pb-12 md:pt-10">
        <PageHeader title="Privacy policy" />
        <article className="prose prose-zinc max-w-none rounded-2xl border border-zinc-200 bg-surface p-6 shadow-sm sm:p-8 prose-h2:mb-3 prose-h2:mt-8 prose-h2:text-lg prose-h2:font-semibold prose-h3:text-base prose-table:text-sm prose-a:text-brand-700">
          <div dangerouslySetInnerHTML={{ __html: html }} />
        </article>
      </div>
    </div>
  );
}
