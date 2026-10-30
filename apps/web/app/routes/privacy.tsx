import { pageMeta } from "../lib/page-meta";
export const meta = () => pageMeta("Privacy policy", "How Open Langford collects and uses public records and personal information, including analytics and your privacy choices.", "/privacy");

import { DEFAULT_MUNICIPALITY } from "../lib/site-config";
import { Link, useLoaderData, useRouteLoaderData } from "react-router";
import { createSupabaseServerClient } from "../lib/supabase.server";
import { getConfiguredVideoProviderId } from "../services/video/index.server";
import { VIDEO_PROVIDERS, type VideoProviderId } from "../services/video/catalog";
import type { Municipality } from "../lib/types";
import { siteName } from "../lib/site-name";
import { PageHeader } from "../components/ui/page-header";

export async function loader({ request }: { request: Request }) {
  const { supabase } = createSupabaseServerClient(request);
  // Default to Vimeo wording (the upstream project's provider) when nothing is configured.
  const videoProvider: VideoProviderId = (await getConfiguredVideoProviderId(supabase)) ?? "vimeo";
  return { videoProvider };
}

export default function Privacy() {
  const { videoProvider } = useLoaderData<typeof loader>();
  const rootData = useRouteLoaderData("root") as { municipality?: Municipality } | undefined;
  const municipalityName = rootData?.municipality?.name || DEFAULT_MUNICIPALITY.name;
  const name = siteName(rootData?.municipality);
  const videoPrivacy = VIDEO_PROVIDERS[videoProvider].privacy(municipalityName);
  return (
    <div className="min-h-screen bg-zinc-50">
      <div className="container mx-auto max-w-3xl px-4 py-12">
        <PageHeader title="Privacy policy" />
        <div className="prose prose-zinc max-w-none rounded-2xl border border-zinc-200 bg-surface p-6 shadow-sm sm:p-8 prose-h2:text-lg prose-h2:font-semibold prose-h2:mt-8 prose-h2:mb-3">
        <p className="text-sm text-zinc-500">Last Updated: February 10, 2026</p>

        <h2>1. Data Collection</h2>
        <p>
          {name} primarily aggregates data from public records provided by
          the {municipalityName}. This includes meeting agendas, minutes, voting
          records, and public video broadcasts.
        </p>

        <h2>2. Personal Information</h2>
        <p>
          We do not collect personal information from visitors to this site
          unless you explicitly provide it (e.g., via contact forms). We use
          industry-standard cookies for session management and basic analytics.
        </p>

        <h2>3. Third Parties</h2>
        <p>
          We use Supabase for data storage and authentication
          {videoPrivacy.weUse ? `, ${videoPrivacy.weUse}, and ` : " and "}PostHog for anonymous usage
          statistics such as page views and search questions.
          {videoPrivacy.note ? ` ${videoPrivacy.note}` : ""} Please refer to their respective privacy
          policies for more information.
        </p>

        <div className="not-prose mt-8 rounded-xl border border-dashed border-zinc-300 p-4">
          <p className="text-sm text-zinc-500">
            This is a placeholder policy. Before going live, please ensure this
            accurately reflects your actual data handling practices.
          </p>
        </div>
      </div>
    </div>
    </div>
  );
}
