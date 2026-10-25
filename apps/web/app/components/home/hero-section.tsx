import { useSiteFlags } from "../../lib/use-site-flags";
import { Link } from "react-router";
import type { ComponentProps } from "react";
import { RecentMeetingSection } from "./recent-meeting-section";
import { UpcomingMeetingSection } from "./upcoming-meeting-section";

interface HeroSectionProps {
  shortName: string;
  user: any;
  recentMeeting: ComponentProps<typeof RecentMeetingSection>;
  upcomingMeeting: ComponentProps<typeof UpcomingMeetingSection>["meeting"];
}

export function HeroSection({ shortName, user, recentMeeting, upcomingMeeting }: HeroSectionProps) {
  const { signupsEnabled } = useSiteFlags();
  return (
    <div className="relative bg-gradient-to-b from-brand-600 to-brand-700 text-white overflow-hidden">
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        {/* Gradient overlays */}
        <div className="absolute inset-0 bg-gradient-to-b from-brand-600/90 via-brand-700/80 to-brand-800/95" />
        <div className="absolute inset-0 bg-gradient-to-r from-brand-700/60 via-transparent to-brand-700/60" />
      </div>

      <div className="relative container mx-auto max-w-6xl px-4 py-10 md:py-12">
        <div className="mb-8 max-w-2xl">
          <h1 className="text-3xl md:text-4xl font-extrabold tracking-tight mb-2">
            What's happening in {shortName}?
          </h1>
          <p className="text-brand-100 text-base md:text-lg">
            The latest from council, from official records and transcripts.
          </p>
        </div>

        <div className="grid grid-cols-1 gap-x-8 gap-y-10 lg:grid-cols-3">
          <div className="lg:col-span-2">
            <RecentMeetingSection {...recentMeeting} inverse />
          </div>
          <UpcomingMeetingSection meeting={upcomingMeeting} inverse />
        </div>

        {/* Account CTA for logged-out users */}
        {!user && signupsEnabled && (
          <div className="mt-8">
            <Link
              to="/signup"
              className="inline-flex items-center text-sm text-brand-200 hover:text-white transition-colors underline underline-offset-2"
            >
              Create an account to track what matters to you
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}
