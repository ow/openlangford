import { pageMeta } from "../lib/page-meta";
export const meta = () => pageMeta("Terms of service", "Terms for using Open Langford, including the accuracy of AI-processed council records and links to official sources.", "/terms");

import { DEFAULT_MUNICIPALITY } from "../lib/site-config";
import { Link, useRouteLoaderData } from "react-router";
import type { Municipality } from "../lib/types";
import { siteName } from "../lib/site-name";
import { PageHeader } from "../components/ui/page-header";

export default function Terms() {
  const rootData = useRouteLoaderData("root") as { municipality?: Municipality } | undefined;
  const shortName = rootData?.municipality?.short_name || DEFAULT_MUNICIPALITY.short_name;
  const name = siteName(rootData?.municipality);
  return (
    <div className="min-h-screen bg-zinc-50">
      <div className="container mx-auto max-w-3xl px-4 py-12">
        <PageHeader title="Terms of service" />
        <div className="prose prose-zinc max-w-none rounded-2xl border border-zinc-200 bg-surface p-6 shadow-sm sm:p-8 prose-h2:text-lg prose-h2:font-semibold prose-h2:mt-8 prose-h2:mb-3">
        <p className="text-sm text-zinc-500">Last Updated: February 10, 2026</p>

        <h2>1. Accuracy of Data</h2>
        <p>
          {name} is an independent platform. While we strive for 100%
          accuracy, our data is processed using AI and automated tools. It
          should be used for informational purposes only. The official
          agendas, minutes and meeting videos are on the
          <a
            href={DEFAULT_MUNICIPALITY.meetingPortalUrl}
            className="text-brand-600 ml-1"
            target="_blank"
            rel="noopener noreferrer"
          >
            {shortName} council meetings website
          </a>
          .
        </p>

        <h2>2. Intellectual Property</h2>
        <p>
          The underlying data is public record. The specific visual
          presentations, analysis, and AI-generated insights are property of
          {name}.
        </p>

        <h2>3. Limitation of Liability</h2>
        <p>
          We are not liable for any decisions made based on the information
          presented on this platform.
        </p>

        <div className="not-prose mt-8 rounded-xl border border-dashed border-zinc-300 p-4">
          <p className="text-sm text-zinc-500">
            This is a placeholder agreement. Please review with legal counsel if
            necessary.
          </p>
        </div>
      </div>
    </div>
    </div>
  );
}
