import { onboardingNotice } from "../lib/onboarding-notice.server";
import { OnboardingCompleteNotice } from "../components/onboarding-complete-notice";
import { useSiteFlags } from "../lib/use-site-flags";
import { DEFAULT_MUNICIPALITY } from "../lib/site-config";
import type { Route } from "./+types/home";
import { data as routeData, Await, useRouteLoaderData } from "react-router";
import { Suspense } from "react";
import { getPublicHomeData, getPublicNotices } from "../services/site";
import { publicData } from "../services/public-data-cache.server";
import { civicToday } from "../lib/council-terms";
import { getSupabasePublicClient } from "../lib/supabase.server";
import { timed } from "../lib/server-timing.server";
import { getMunicipality } from "../services/municipality";
import type { Municipality } from "../lib/types";
import { IncomingCouncilSection } from "../components/home/incoming-council-section";
import { getIncomingCouncil } from "../services/incoming-council";
import { AskSection } from "../components/home/ask-section";
import { RecentMeetingSection } from "../components/home/recent-meeting-section";
import { HeroDecisions } from "../components/home/hero-decisions";
import { ActiveMattersSection } from "../components/home/active-matters-section";
import { DecisionsFeedSection } from "../components/home/decisions-feed-section";
import { PublicNoticesSection } from "../components/home/public-notices-section";
import { ogImageUrl } from "../lib/og";
import { pageMeta } from "../lib/page-meta";
import { websiteGraph } from "../lib/structured-data";

export const meta: Route.MetaFunction = ({ data }) => {
  const municipality = (data as any)?.municipality as Municipality | undefined;
  const municipalityName = municipality?.name || DEFAULT_MUNICIPALITY.name;
  return [
    ...pageMeta(
      "Langford Council Meetings, Bylaws & Records",
      `Search every ${municipalityName} council meeting, decision, vote, bylaw and development application, with plain-language summaries, video and the original records.`,
      "/",
      "website",
      { image: ogImageUrl("Langford council meetings, decisions and bylaws in plain language") },
    ),
    websiteGraph(),
  ];
};

export async function loader({ request }: { request: Request }) {
  try {
    // Session-free apart from the onboarding flash cookie: a request carrying it is never
    // served from or stored in the shared caches (it fails cache admission).
    const headers = new Headers();
    const onboardingComplete = await onboardingNotice.parse(request.headers.get("Cookie")) === "complete";
    if (onboardingComplete) {
      headers.append("Set-Cookie", await onboardingNotice.serialize("", { maxAge: 0 }));
      headers.set("Cache-Control", "private, no-store");
    }
    // getMunicipality call is intentionally duplicated from root loader.
    // The home loader needs rss_url at server time for getPublicNotices(),
    // and React Router 7 child loaders cannot access parent loader data on the server.
    const municipality = await timed("home-municipality", getMunicipality(getSupabasePublicClient()));
    const [data, publicNotices, incomingCouncil] = await Promise.all([
      timed("home-data", getPublicHomeData(municipality.id, municipality.meta)),
      timed("home-notices", getPublicNotices(municipality.rss_url)),
      timed("home-incoming", publicData(`incoming-council:${municipality.id}:${civicToday()}`, () => getIncomingCouncil(getSupabasePublicClient(), municipality.id),
        () => true, undefined, { shareWithSignedIn: true }).catch((error) => {
        console.error("Error loading incoming council:", error);
        return null;
      })),
    ]);

    return routeData({
      onboardingComplete,
      upcomingMeeting: data.upcomingMeeting,
      laterMeetings: data.laterMeetings,
      recentMeeting: data.recentMeeting,
      recentMeetingStats: data.recentMeetingStats,
      recentMeetingDecisions: data.recentMeetingDecisions,
      activeMatters: data.activeMatters,
      recentDecisions: data.recentDecisions,
      publicNotices,
      municipality,
      incomingCouncil,
    }, { headers });
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
    recentMeetingStats,
    recentMeetingDecisions,
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
  const { emailAlertsAvailable: alertsAvailable } = useSiteFlags();
  const shortName =
    (municipality as Municipality)?.short_name || DEFAULT_MUNICIPALITY.short_name;

  return (
    <div className="min-h-screen bg-zinc-50">
      {user && loaderData.onboardingComplete && <OnboardingCompleteNotice alertsAvailable={alertsAvailable} />}
      <HeroDecisions
        shortName={shortName}
        decisions={recentDecisions}
        upcoming={[upcomingMeeting, ...laterMeetings].filter(Boolean)}
      />
      <IncomingCouncilSection council={incomingCouncil} />

      <div className="container mx-auto max-w-6xl px-4 py-12">
        <div className="grid grid-cols-1 gap-x-8 gap-y-12 lg:grid-cols-3">
          <div className="space-y-12 lg:col-span-2">
            <RecentMeetingSection
              meeting={recentMeeting}
              stats={recentMeetingStats}
              decisions={recentMeetingDecisions}
            />
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

