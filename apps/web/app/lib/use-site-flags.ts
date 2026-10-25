import { useRouteLoaderData } from "react-router";

/** Client-side view of server feature flags (from the root loader). */
export function useSiteFlags() {
  const data = useRouteLoaderData("root") as
    | {
        signupsEnabled?: boolean;
        emailAlertsAvailable?: boolean;
        aiSearchAvailable?: boolean;
      }
    | undefined;
  return {
    emailAlertsAvailable: data?.emailAlertsAvailable ?? false,
    signupsEnabled: data?.signupsEnabled ?? true,
    aiSearchAvailable: data?.aiSearchAvailable ?? false,
  };
}
