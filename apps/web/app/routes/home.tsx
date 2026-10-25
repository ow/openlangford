import { SITE_NAME } from "../lib/site-name";
import { DEFAULT_MUNICIPALITY } from "../lib/site-config";
import type { Route } from "./+types/home";
import { Await, Link, useRouteLoaderData, useSearchParams } from "react-router";
import { Suspense } from "react";
import { getPublicHomeData, getPublicNotices } from "../services/site";
import { publicData } from "../services/public-data-cache.server";
import { civicToday } from "../lib/council-terms";
import { getSupabasePublicClient, createSupabaseServerClient } from "../lib/supabase.server";
import { getMunicipality } from "../services/municipality";
import type { Municipality } from "../lib/types";
import { HeroSection } from "../components/home/hero-section";
import { IncomingCouncilSection } from "../components/home/incoming-council-section";
import { getIncomingCouncil } from "../services/incoming-council";
import { AskSection } from "../components/home/ask-section";
import { HeroDecisions } from "../components/home/hero-decisions";
import { HeroTimeline } from "../components/home/hero-timeline";
import { ActiveMattersSection } from "../components/home/active-matters-section";
import { DecisionsFeedSection } from "../components/home/decisions-feed-section";
import { PublicNoticesSection } from "../components/home/public-notices-section";
import { ogImageUrl, ogUrl } from "../lib/og";

export const meta: Route.MetaFunction = ({ data }) => {
  const municipality = (data as any)?.municipality as Municipality | undefined;
  const municipalityName = municipality?.name || DEFAULT_MUNICIPALITY.name;
  return [
    { title: `${SITE_NAME} | Council Meeting Intelligence` },
    { name: "description", content: `Searchable database of ${municipalityName} council meetings, voting records, and AI-powered insights.` },
    { property: "og:title", content: `${SITE_NAME} | Council Meeting Intelligence` },
    { property: "og:description", content: `AI-powered civic transparency platform for the ${municipalityName}.` },
    { property: "og:type", content: "website" },
    { property: "og:url", content: ogUrl("/") },
    { property: "og:image", content: ogImageUrl("Council Meeting Intelligence") },
    { property: "og:image:width", content: "1200" },
    { property: "og:image:height", content: "630" },
    { name: "twitter:card", content: "summary_large_image" },
  ];
};

export async function loader({ request }: { request: Request }) {
  try {
    const { supabase } = createSupabaseServerClient(request);
    // getMunicipality call is intentionally duplicated from root loader.
    // The home loader needs rss_url at server time for getPublicNotices(),
    // and React Router 7 child loaders cannot access parent loader data on the server.
    const municipality = await getMunicipality(supabase);
    const [data, publicNotices, incomingCouncil] = await Promise.all([
      getPublicHomeData(municipality.id, municipality.meta),
      getPublicNotices(municipality.rss_url),
      publicData(`incoming-council:${municipality.id}:${civicToday()}`, () => getIncomingCouncil(getSupabasePublicClient(), municipality.id)).catch((error) => {
        console.error("Error loading incoming council:", error);
        return null;
      }),
    ]);

    return {
      upcomingMeeting: data.upcomingMeeting,
      laterMeetings: data.laterMeetings,
      recentMeeting: data.recentMeeting,
      earlierMeetings: data.earlierMeetings,
      recentMeetingStats: data.recentMeetingStats,
      activeMatters: data.activeMatters,
      recentDecisions: data.recentDecisions,
      publicNotices,
      municipality,
      incomingCouncil,
    };
  } catch (error) {
    console.error("Error loading home data:", error);
    throw new Response("Error loading dashboard", { status: 500 });
  }
}

export default function Home({ loaderData }: any) {
  const {
    upcomingMeeting,
    laterMeetings,
    recentMeeting,
    earlierMeetings,
    recentMeetingStats,
    activeMatters,
    recentDecisions,
    publicNotices,
    municipality,
    incomingCouncil,
  } = loaderData;

  const rootData = useRouteLoaderData("root") as
    | { user: any }
    | undefined;
  const user = rootData?.user;
  const [searchParams] = useSearchParams();
  const heroVariant = searchParams.get("hero") ?? "cards";
  const shortName =
    (municipality as Municipality)?.short_name || DEFAULT_MUNICIPALITY.short_name;

  return (
    <div className="min-h-screen bg-zinc-50">
      {heroVariant === "decisions" ? (
        <HeroDecisions
          shortName={shortName}
          decisions={recentDecisions}
          upcoming={[upcomingMeeting, ...laterMeetings].filter(Boolean)}
        />
      ) : heroVariant === "timeline" ? (
        <HeroTimeline
          shortName={shortName}
          past={[recentMeeting, ...earlierMeetings].filter(Boolean)}
          upcoming={[upcomingMeeting, ...laterMeetings].filter(Boolean)}
        />
      ) : (
        <HeroSection
          shortName={shortName}
          user={user}
          recentMeeting={{ meeting: recentMeeting, stats: recentMeetingStats }}
          upcomingMeeting={upcomingMeeting}
          laterMeetings={laterMeetings}
        />
      )}
      {import.meta.env.DEV && <HeroVariantSwitcher current={heroVariant} />}
      <IncomingCouncilSection council={incomingCouncil} />

      <div className="container mx-auto max-w-6xl px-4 py-12">
        <div className="grid grid-cols-1 gap-x-8 gap-y-12 lg:grid-cols-3">
          <div className="lg:col-span-2">
            <DecisionsFeedSection decisions={recentDecisions} />
          </div>
          <aside className="space-y-12">
            <ActiveMattersSection matters={activeMatters} />
            <Suspense fallback={null}>
              <Await resolve={publicNotices} errorElement={null}>
                {(notices) => <PublicNoticesSection notices={notices} websiteUrl={municipality?.website_url} />}
              </Await>
            </Suspense>
          </aside>
        </div>
      </div>

      <AskSection shortName={shortName} />
    </div>
  );
}

// Temporary: compare hero directions locally. Remove before merging.
function HeroVariantSwitcher({ current }: { current: string }) {
  const variants = [
    ["cards", "Cards"],
    ["decisions", "Decisions"],
    ["timeline", "Timeline"],
  ];
  return (
    <nav className="fixed bottom-4 left-1/2 z-50 flex -translate-x-1/2 gap-1 rounded-full bg-zinc-900 p-1 text-sm shadow-xl">
      {variants.map(([key, label]) => (
        <Link
          key={key}
          to={`/?hero=${key}`}
          preventScrollReset
          className={current === key ? "rounded-full bg-white px-3 py-1.5 font-semibold text-zinc-900" : "rounded-full px-3 py-1.5 text-zinc-300 hover:text-white"}
        >
          {label}
        </Link>
      ))}
    </nav>
  );
}
